"use client";

import { type CSSProperties, FormEvent, useEffect, useRef, useState } from "react";
import { generationDots, generationLabel, readGenerationResponse, type GenerationPhase } from "@/lib/generation-progress";
import { normalizeMarkdown } from "@/lib/markdown-format";
import { ECONOMY_MODELS } from "@/lib/model-defaults";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkMath from "remark-math";
import { FILE_ACCEPT, classifyFile, attachmentPrompt, validateAttachments, type AttachedDocument } from "@/lib/file-attachments";
import type { PdfReference } from "@/lib/pdf-context";
import { messageDisplay } from "@/lib/message-display";
import { comparisonStatus } from "@/lib/comparison-status";
import { isValidatedConflict, conflictDifference } from "@/lib/conflict-validation";
import type { AnswerComparison } from "@/lib/answer-comparison";
import { prepareProjectMessages, type Project, type ProjectFile } from "@/lib/project-context";
import { supabase } from "@/lib/supabase";
import styles from "./page.module.css";

const THEME_KEY = "consensus-ai-theme";

type ModelResponse = {
  provider: "GPT" | "Gemini" | "Claude";
  content: string;
};

type ConsensusClaim = {
  claim: string;
  supportCount: number;
  totalModels: number;
  status: "full" | "majority" | "disputed" | "unique";
  notes?: string;
};

type ChatTurn = {
  referenceDocuments?: PdfReference[];
  displayContent?: string;
  attachedFileNames?: string[];
  role: "user" | "assistant";
  content: string;
  image?: {
    dataUrl: string;
    mimeType: string;
  };
  images?: Array<{ dataUrl: string; mimeType: string; name?: string }>;
  result?: ResponsePayload;
};

type ResponsePayload = {
  attemptedProviderCount?: number;
  comparison?: AnswerComparison;
  consensus: string;
  agreementScore: number | null;
  summary: string;
  agreements: string[];
  disagreements: string[];
  confidenceNote: string;
  claims: ConsensusClaim[];
  responses: ModelResponse[];
  errors: { provider: string; message: string }[];
  requestId: string;
  retryable?: boolean;
  usage: { creditCharged: number; creditsRemaining: number };
};

type ChatSession = {
  project_id?: string | null;
  id: string;
  title: string;
  chat: ChatTurn[];
  result: ResponsePayload | null;
};

type ProviderName = "GPT" | "Gemini" | "Claude";
type ModelCatalog = Record<ProviderName, string[]>;
type UsageSummary = {
  plan: string;
  subscriptionStatus: string;
  hasBillingAccount: boolean;
  periodEnd: string;
  includedCredits: number;
  creditsUsed: number;
  creditsRemaining: number;
  topupAvailable?: boolean;
};

type ProviderSettings = {
  enabled: boolean;
  model: string;
};

type AppSettings = Record<ProviderName, ProviderSettings> & {
  consensusDropdownDefaultOpen: boolean;
  economyDefaultsApplied?: boolean;
};

type SettingsProfile = {
  id: string;
  name: string;
  settings: AppSettings;
};

const CHAT_HISTORY_KEY = "consensus-ai-chat-history";
const SETTINGS_KEY = "consensus-ai-settings";
const PROFILES_KEY = "consensus-ai-profiles";
const EMPTY_CHAT: ChatTurn[] = [];

let guestSessionPromise: ReturnType<typeof supabase.auth.signInAnonymously> | null = null;

async function ensureBrowserSession() {
  const { data } = await supabase.auth.getSession();
  if (data.session) return data.session;
  guestSessionPromise ??= supabase.auth.signInAnonymously();
  try {
    const result = await guestSessionPromise;
    if (result.error || !result.data.session) throw new Error("Guest access is unavailable. Please try again shortly or sign in.");
    return result.data.session;
  } finally { guestSessionPromise = null; }
}

async function authenticatedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const { data } = await supabase.auth.getSession();
  const accessToken = data.session?.access_token;
  if (!accessToken) throw new Error("Sign in to continue.");
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${accessToken}`);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return fetch(path, { ...init, headers });
}

function TrashIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" />
                </svg>
  );
}

function UploadIcon() {
  return (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 16V3m-5 5 5-5 5 5M4 16v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4" />
            </svg>
  );
}

function FormattedMarkdown({ children }: { children: string }) {
  const normalized = normalizeMarkdown(children);

  return (
    <ReactMarkdown remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex]}>
      {normalized}
    </ReactMarkdown>
  );
}

const defaultSettings: AppSettings = {
  GPT: { enabled: true, model: ECONOMY_MODELS.GPT },
  Gemini: { enabled: true, model: ECONOMY_MODELS.Gemini },
  Claude: { enabled: false, model: ECONOMY_MODELS.Claude },
  consensusDropdownDefaultOpen: false,
  economyDefaultsApplied: true,
};

const fallbackModels: ModelCatalog = {
  GPT: [ECONOMY_MODELS.GPT],
  Gemini: [ECONOMY_MODELS.Gemini],
  Claude: [ECONOMY_MODELS.Claude],
};

function createChatSession(): ChatSession {
  return {
    id: crypto.randomUUID(),
    title: "New chat",
    chat: [],
    result: null,
  };
}

function createSettingsProfile(name: string, settings: AppSettings = defaultSettings): SettingsProfile {
  return { id: crypto.randomUUID(), name, settings };
}

function normalizeSettings(settings: Partial<AppSettings>): AppSettings {
  const stored = settings as Partial<AppSettings> & Record<ProviderName, { enabled?: boolean; model?: string; apiKey?: string }>;
  return {
    GPT: {
      enabled: stored.GPT?.enabled !== false,
      model: stored.GPT?.model || defaultSettings.GPT.model,
    },
    Gemini: {
      enabled: stored.Gemini?.enabled !== false,
      model: stored.Gemini?.model || defaultSettings.Gemini.model,
    },
    Claude: {
      enabled: stored.Claude?.enabled === true,
      model: stored.Claude?.model || defaultSettings.Claude.model,
    },
    consensusDropdownDefaultOpen: settings.consensusDropdownDefaultOpen === true,
    economyDefaultsApplied: settings.economyDefaultsApplied === true,
  };
}

function ensureUniqueProfileNames(profiles: SettingsProfile[]): SettingsProfile[] {
  const usedNames = new Set<string>();
  return profiles.map((profile) => {
    const baseName = profile.name.trim() || "Profile";
    let name = baseName;
    let suffix = 2;
    while (usedNames.has(name.toLocaleLowerCase())) {
      name = `${baseName} (${suffix})`;
      suffix += 1;
    }
    usedNames.add(name.toLocaleLowerCase());
    return { ...profile, name };
  });
}

function getUniqueProfileName(name: string, profiles: SettingsProfile[]): string {
  const baseName = name.trim() || "New profile";
  const usedNames = new Set(profiles.map((profile) => profile.name.trim().toLocaleLowerCase()));
  let uniqueName = baseName;
  let suffix = 2;
  while (usedNames.has(uniqueName.toLocaleLowerCase())) {
    uniqueName = `${baseName} (${suffix})`;
    suffix += 1;
  }
  return uniqueName;
}

function getEnabledProviderLabel(settings: AppSettings): string {
  const providers = (["GPT", "Gemini", "Claude"] as ProviderName[])
    .filter((provider) => settings[provider].enabled);
  return providers.length ? providers.join(", ") : "selected models";
}

function hydrateSessionResults(session: ChatSession): ChatSession {
  if (!session.result) return session;

  const nextResult = session.result;

  return {
    ...session,
    chat: session.chat.map((message) => (
      message.role === "assistant" && !message.result
        ? { ...message, result: nextResult }
        : message
    )),
  };
}

function ComparisonBreakdown({ comparison }: { comparison: AnswerComparison }) {
  const conflicts = comparison.conflicts.filter(isValidatedConflict);
  const unverified = comparison.conflicts.filter(c => !isValidatedConflict(c));
  const differences = [...comparison.reasoningDifferences, ...unverified.map(conflictDifference)];
  if (comparison.kind === "multi_question") {
    return <div className={styles.questionBreakdowns}>
      {comparison.questions?.map((question, index) => (
        <section key={index}>
          <h4>{index + 1}. {question.question}</h4>
          <p className={styles.settingsNote}>{question.summary}</p>
          <ComparisonBreakdown comparison={question.comparison} />
        </section>
      ))}
    </div>;
  }
  return <>
            {comparison.issues?.length ? <p className={styles.settingsNote}>Some comparison details could not be verified. The available evidence is shown below.</p> : null}
            {comparison.kind === "multiple_choice" && <div className={styles.metaCard}>
              <h4>Answer choices</h4>
              <ul>{comparison.votes.map(vote => <li key={vote.provider}>
                <strong>{vote.provider}: {vote.choice ?? "No clear selection"}</strong>
                {vote.quote && <blockquote>{vote.quote}</blockquote>}
              </li>)}</ul>
            </div>}
            <div className={styles.metaGrid}>
              <div className={styles.metaCard}>
                <h4>Shared reasoning</h4>
                {comparison.sharedReasoning.length ? comparison.sharedReasoning.map((point, index) => <div key={index}>
                  <FormattedMarkdown>{point.point}</FormattedMarkdown>
                  {point.evidence.map(e => <blockquote key={e.provider}><strong>{e.provider}:</strong> {e.quote}</blockquote>)}
                </div>) : <p>No shared reasoning identified. This does not imply disagreement.</p>}
              </div>
              <div className={styles.metaCard}>
                <h4>Conflicting claims</h4>
                {conflicts.length ? conflicts.map((conflict, index) => <div key={index}>
                  <FormattedMarkdown>{conflict.validation!.contradiction}</FormattedMarkdown>
                  {conflict.positions.map((position, i) => <div key={i}>
                    <FormattedMarkdown>{position.claim}</FormattedMarkdown>
                    {position.evidence.map(e => <blockquote key={e.provider}><strong>{e.provider}:</strong> {e.quote}</blockquote>)}
                  </div>)}
                </div>) : <p>{(comparison.issues?.length || unverified.length) ? "The conflict check is incomplete. Do not interpret this as agreement." : "No explicit conflicts identified in the responding models’ answers."}</p>}
              </div>
            </div>
            {differences.length > 0 && <div className={styles.metaCard}>
              <h4>Different explanations, not disagreements</h4>
              <ul>{differences.map((item, index) => <li key={index}><FormattedMarkdown>{item}</FormattedMarkdown></li>)}</ul>
            </div>}
  </>;
}

function ConsensusDetails({
  result,
  onRetry,
  disabled,
  defaultOpen = false,
}: {
  result: ResponsePayload;
  onRetry: () => void;
  disabled: boolean;
  defaultOpen?: boolean;
}) {
  const comparison = result.comparison;




  return (
    <div className={styles.consensusDetailsWrap}>
      <p className={styles.comparisonStatus}>{comparisonStatus(result)}</p>
      <details className={styles.consensusDetails} open={defaultOpen}>
        <summary className={styles.consensusSummary}>
          <span>Compare models</span>
        </summary>

        <div className={styles.consensusBody}>
          {comparison ? <ComparisonBreakdown comparison={comparison} /> :
            <p>Detailed comparison is unavailable for this answer. Review the individual answers below or retry.</p>}

          <div className={styles.providerPanel}>
            <h4>View individual answers</h4>
            {result.responses.map((response) => (
              <details key={response.provider} className={styles.providerCard}>
                <summary>{response.provider}</summary>
                <div className={styles.providerContent}><FormattedMarkdown>{response.content}</FormattedMarkdown></div>
              </details>
            ))}
          </div>
        </div>
      </details>

      <button
        type="button"
        className={styles.regenerateButton}
        onClick={onRetry}
        disabled={disabled}
        aria-label="Rerun with selected models"
        title="Rerun with selected models"
      >
        <span aria-hidden="true">↻</span> Rerun with selected models
      </button>
    </div>
  );
}

export default function Home() {
  const [input, setInput] = useState("");
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectReady, setProjectReady] = useState(false);
  const [projectError, setProjectError] = useState("");
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<string[]>([]);
  const [draggedChat, setDraggedChat] = useState<string | null>(null);
  const [dropFolder, setDropFolder] = useState<string | null>(null);
  const [chatMenuPosition, setChatMenuPosition] = useState({ left: 16, top: 120 });
  const [chatMenu, setChatMenu] = useState<string | null>(null);
  const chatMenuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => { if (chatMenu) chatMenuRef.current?.querySelector<HTMLButtonElement>("button")?.focus(); }, [chatMenu]);
  const [projectBusy, setProjectBusy] = useState(false);
  const projectFileInputRef = useRef<HTMLInputElement | null>(null);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeChatId, setActiveChatIdState] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [generationPhase, setGenerationPhase] = useState<GenerationPhase>("providers");
  const [generationModelCount, setGenerationModelCount] = useState(1);
  const generationController = useRef<AbortController | null>(null);
  useEffect(() => () => generationController.current?.abort(), []);
  const [, setStatusText] = useState("Ready to compare model responses.");
  const [error, setError] = useState<string | null>(null);
  const [isDark, setIsDark] = useState(true);
  const [attachedDocuments, setAttachedDocuments] = useState<AttachedDocument[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [isReadingFiles, setIsReadingFiles] = useState(false);
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const readingFilesRef = useRef(false);
  const draftGeneration = useRef(0);
  const dragDepth = useRef(0);
  const [pastedImages, setPastedImages] = useState<NonNullable<ChatTurn["images"]>>([]);
  const [settings, setSettings] = useState<AppSettings>(defaultSettings);
  const [usageSummary, setUsageSummary] = useState<UsageSummary | null>(null);
  const [billingBusy, setBillingBusy] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [authNotice, setAuthNotice] = useState("");
  const [modelCatalog, setModelCatalog] = useState<ModelCatalog>(fallbackModels);
  const [modelDiscoveryErrors, setModelDiscoveryErrors] = useState<Partial<Record<ProviderName, string>>>({});
  const [profiles, setProfiles] = useState<SettingsProfile[]>([]);
  const [activeProfileId, setActiveProfileId] = useState("");
  const [profileName, setProfileName] = useState("Default");
  const [profileNameError, setProfileNameError] = useState("");
  const [profilesLoaded, setProfilesLoaded] = useState(false);
  const [isGuest, setIsGuest] = useState(true);
  const [showAccountForm, setShowAccountForm] = useState(false);
  const [guestError, setGuestError] = useState("");
  const [userEmail, setUserEmail] = useState("");
  const [userId, setUserId] = useState("");
  const [authChecked, setAuthChecked] = useState(false);
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authMode, setAuthMode] = useState<"login" | "signup">("login");
  const [authError, setAuthError] = useState("");
  const [profileSyncError, setProfileSyncError] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const field = composerRef.current;
    if (!field) return;
    field.style.height = "auto";
    field.style.overflowY = "hidden";
    if (!input) {
      field.scrollTop = 0;
      return;
    }
    // scrollHeight includes padding, but not the border-box borders.
    const borderHeight = field.offsetHeight - field.clientHeight;
    const height = field.scrollHeight + borderHeight;
    field.style.height = `${Math.min(height, 180)}px`;
    field.style.overflowY = height > 180 ? "auto" : "hidden";
  }, [input]);
  function setActiveChatId(id: string) {
    // Discard a pending read when switching chats; attachments belong to a draft.
    setActiveChatIdState(id);
    draftGeneration.current += 1;
    setPastedImages([]);
    setAttachedDocuments([]);
    setAttachmentError(null);
    setIsDraggingFiles(false);
    dragDepth.current = 0;
  }

  const [lastRequest, setLastRequest] = useState<{ messages: ChatTurn[]; userTurn: ChatTurn; sessionId: string; requestId: string; retryable?: boolean } | null>(null);
  const activeSession = sessions.find((session) => session.id === activeChatId) ?? sessions[0];
  const activeProject = projects.find(project => project.id === selectedProjectId);

  const chat = activeSession?.chat ?? EMPTY_CHAT;
  const result = activeSession?.result ?? null;

  useEffect(() => {
    let active = true;
    async function loadAccount() {
      setProjectReady(false);
      setProjects([]);
      try { await ensureBrowserSession(); }
      catch (guestFailure) {
        if (active) {
          setGuestError(guestFailure instanceof Error ? guestFailure.message : "Guest access is unavailable.");
          setAuthChecked(true);
        }
        return;
      }
      const { data } = await supabase.auth.getUser();
      if (!active) return;
      if (!data.user) {
        window.localStorage.removeItem(PROFILES_KEY);
        window.localStorage.removeItem(SETTINGS_KEY);
        window.localStorage.removeItem(CHAT_HISTORY_KEY);
        const defaultProfile = createSettingsProfile("Default");
        setProfiles([defaultProfile]);
        setActiveProfileId(defaultProfile.id);
        setProfileName(defaultProfile.name);
        setSettings(defaultProfile.settings);
        setProfilesLoaded(true);
        const firstSession = createChatSession();
        setSessions([firstSession]);
        setActiveChatId(firstSession.id);
        setSelectedProjectId(null);
        setUserEmail("");
        setUserId("");
        setAuthChecked(true);
        return;
      }
      setGuestError("");
      setIsGuest(data.user.is_anonymous === true);
      setUserEmail(data.user.is_anonymous ? "" : data.user.email ?? "");
      setUserId(data.user.id);
      let remoteProfiles: SettingsProfile[] = [];
      try {
        const profileResponse = await authenticatedFetch("/api/settings/profiles");
        const profilePayload = await profileResponse.json() as { profiles?: SettingsProfile[]; error?: string };
        if (!profileResponse.ok) throw new Error(profilePayload.error ?? "Could not load profiles.");
        remoteProfiles = profilePayload.profiles ?? [];
      } catch (loadError) {
        setProfileSyncError(loadError instanceof Error ? loadError.message : "Profile storage error.");
        setProfilesLoaded(true);
        setAuthChecked(true);
        return;
      }
      if (remoteProfiles?.length) {
        const nextProfiles = ensureUniqueProfileNames((remoteProfiles as SettingsProfile[]).map((profile) => ({
          ...profile,
          settings: normalizeSettings(profile.settings),
        })));
        setProfiles(nextProfiles);
        setActiveProfileId(nextProfiles[0].id);
        setProfileName(nextProfiles[0].name);
        setSettings(nextProfiles[0].settings);
      } else {
        const defaultProfile = createSettingsProfile("Default");
        setProfiles([defaultProfile]);
        setActiveProfileId(defaultProfile.id);
        setProfileName(defaultProfile.name);
        setSettings(defaultProfile.settings);
      }
      const usageResponse = await authenticatedFetch("/api/usage");
      if (usageResponse.ok) {
        const usagePayload = await usageResponse.json() as UsageSummary;
        setUsageSummary(usagePayload);
      } else {
        const usagePayload = await usageResponse.json() as { error?: string };
        setProfileSyncError(usagePayload.error ?? "Billing account unavailable.");
      }
      const { data: remoteProjects, error: projectsError } = await supabase.from("projects").select("id, name, files").order("created_at");
      if (!active) return;
      setProjects((remoteProjects ?? []) as Project[]);
      setProjectReady(!projectsError);
      setProjectError(projectsError ? "Projects need setup: run supabase/projects_migration.sql in your Supabase SQL Editor." : "");
      const { data: remoteChats, error: chatError } = await supabase
        .from("chat_sessions")
        .select("*")
        .order("updated_at", { ascending: false });
      if (chatError) {
        setProfileSyncError(`Chat history error: ${chatError.message}`);
      } else if (remoteChats?.length) {
        const nextSessions = remoteChats as ChatSession[];
        setSessions(nextSessions.map(hydrateSessionResults));
        setActiveChatId(nextSessions[0].id);
        setSelectedProjectId(nextSessions[0].project_id ?? null);
        setExpandedFolders(nextSessions[0].project_id ? [nextSessions[0].project_id] : []);
      } else {
        const firstSession = createChatSession();
        setSessions([firstSession]);
        setActiveChatId(firstSession.id);
        setSelectedProjectId(null);
      }
      setProfilesLoaded(true);
      setAuthChecked(true);
    }
    loadAccount();
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session?.user) {
        setAuthChecked(false);
        setIsGuest(session.user.is_anonymous === true);
        setUserEmail(session.user.is_anonymous ? "" : session.user.email ?? "");
        setUserId(session.user.id);
        window.setTimeout(() => { if (active) void loadAccount(); }, 0);
      } else {
        setUserEmail("");
        setUserId("");
        setAuthChecked(true);
      }
    });
    return () => {
      active = false;
      listener.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!profilesLoaded || !authChecked) return;
    if (!userId) {
      window.localStorage.removeItem(PROFILES_KEY);
      window.localStorage.removeItem(SETTINGS_KEY);
      return;
    }
    const updatedProfiles = profiles.map((profile) => profile.id === activeProfileId
      ? { ...profile, name: profileName, settings }
      : profile);
    window.localStorage.setItem(PROFILES_KEY, JSON.stringify(updatedProfiles));
    if (activeProfileId) {
      authenticatedFetch("/api/settings/profiles", {
        method: "PUT",
        body: JSON.stringify({ id: activeProfileId, name: profileName, settings }),
      }).then(async (response) => {
        if (!response.ok) {
          const payload = await response.json() as { error?: string };
          setProfileSyncError(payload.error ?? "Profile save error.");
        } else {
          setProfileSyncError("");
          if (JSON.stringify(updatedProfiles) !== JSON.stringify(profiles)) setProfiles(updatedProfiles);
        }
      }).catch(() => setProfileSyncError("Profile save error. Check your connection."));
    }
  }, [settings, profileName, activeProfileId, profilesLoaded, profiles, userId, authChecked]);

  useEffect(() => {
    if (authChecked && userId && sessions.length) {
      try { window.localStorage.setItem(CHAT_HISTORY_KEY, JSON.stringify(sessions)); }
      catch { /* Large books may exceed local cache capacity; cloud sync below remains authoritative. */ }
      if (userId) {
        supabase.from("chat_sessions").upsert(sessions.map((session) => ({
          id: session.id,
          user_id: userId,
          title: session.title,
          ...(projectReady ? { project_id: session.project_id ?? null } : {}),
          chat: session.chat,
          result: session.result,
          updated_at: new Date().toISOString(),
        }))).then(({ error: saveError }) => {
          if (saveError) setProfileSyncError(`Chat history save error: ${saveError.message}`);
        });
      }
    }
  }, [authChecked, sessions, userEmail, userId, projectReady]);

  useEffect(() => {
    const storedTheme = window.localStorage.getItem(THEME_KEY);
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const nextTheme = storedTheme ? storedTheme === "dark" : prefersDark;
    const frame = window.requestAnimationFrame(() => setIsDark(nextTheme));
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    window.localStorage.setItem(THEME_KEY, isDark ? "dark" : "light");
  }, [isDark]);

  useEffect(() => {
    if (viewportRef.current) {
      viewportRef.current.scrollTop = viewportRef.current.scrollHeight;
    }
  }, [chat, result, isLoading]);

  useEffect(() => {
    if (!userId) return;

    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setModelDiscoveryErrors({});
      try {
        const response = await authenticatedFetch("/api/models", {
          method: "POST",
          signal: controller.signal,
          body: JSON.stringify({}),
        });
        const payload = await response.json() as {
          models?: ModelCatalog;
          defaults?: Record<ProviderName, string>;
          useEconomyDefaults?: boolean;
          loaded?: Record<ProviderName, boolean>;
          errors?: Partial<Record<ProviderName, string>>;
        };
        if (controller.signal.aborted) return;
        if (!response.ok) throw new Error("Models unavailable");
        if (payload.models) {
          setModelCatalog((current) => ({
            GPT: payload.models?.GPT.length ? payload.models.GPT : current.GPT,
            Gemini: payload.models?.Gemini.length ? payload.models.Gemini : current.Gemini,
            Claude: payload.models?.Claude.length ? payload.models.Claude : current.Claude,
          }));
          setSettings((current) => {
            const applyEconomy = payload.useEconomyDefaults && !current.economyDefaultsApplied;
            const nextSettings = { ...current, economyDefaultsApplied: true };
            for (const provider of ["GPT", "Gemini", "Claude"] as ProviderName[]) {
              const available = payload.models?.[provider] ?? [];
              if (!payload.loaded?.[provider] || !available.length || (!applyEconomy && available.includes(current[provider].model))) continue;
              const preferred = payload.defaults?.[provider] ?? available[0];
              nextSettings[provider] = { ...current[provider], model: preferred };
            }
            return nextSettings;
          });
        }
        setModelDiscoveryErrors(payload.errors ?? {});
      } catch {
        if (!controller.signal.aborted) {
          setModelDiscoveryErrors({
            GPT: "Could not refresh models. Please try again shortly.",
            Gemini: "Could not refresh models. Please try again shortly.",
            Claude: "Could not refresh models. Please try again shortly.",
          });
        }
      }
    }, 300);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [userId, showSettings]);

  useEffect(() => {
    if (!userId || new URLSearchParams(window.location.search).get("billing") !== "return") return;
    const openTimer = window.setTimeout(() => setShowSettings(true), 0);
    let attempts = 0;
    const timer = window.setInterval(async () => {
      attempts += 1;
      if (attempts >= 10) window.clearInterval(timer);
      try {
        const response = await authenticatedFetch("/api/usage");
        if (!response.ok) return;
        const usage = await response.json() as UsageSummary;
        setUsageSummary(usage);
        if (usage.plan === "premium") {
          window.clearInterval(timer);
          window.history.replaceState(null, "", window.location.pathname);
        }
      } catch { /* The normal usage refresh can retry later. */ }
    }, 2000);
    return () => { window.clearTimeout(openTimer); window.clearInterval(timer); };
  }, [userId]);

  async function refreshUsageSummary() {
    try {
      const response = await authenticatedFetch("/api/usage");
      if (!response.ok) return;
      const usage = await response.json() as UsageSummary;
      setUsageSummary(usage);
    } catch {
      setProfileSyncError("Could not refresh plan usage.");
    }
  }

  async function runRequest(requestMessages: ChatTurn[], sessionId: string, requestId: string, requestSettings: AppSettings = settings, retryOf?: string) {
    const controller = new AbortController();
    generationController.current = controller;
    setGenerationPhase("providers");
    setGenerationModelCount((["GPT", "Gemini", "Claude"] as ProviderName[]).filter(p => requestSettings[p].enabled).length);
    try {
      const response = await authenticatedFetch("/api/chat", {
        signal: controller.signal,
        headers: { Accept: "application/x-ndjson" },
        method: "POST",
        body: JSON.stringify({ messages: prepareProjectMessages(requestMessages, projects.find(project => project.id === sessions.find(session => session.id === sessionId)?.project_id)?.files ?? []), settings: requestSettings, requestId, conversationId: sessionId, retryOf }),
      });

      const { payload, ok } = await readGenerationResponse<ResponsePayload & { error?: string }>(response, phase => {
        if (!controller.signal.aborted && generationController.current === controller) setGenerationPhase(phase);
      });
      if (controller.signal.aborted || generationController.current !== controller) return;
      setLastRequest((current) => current?.requestId === requestId
        ? (!ok && !payload.requestId && retryOf
          ? { ...current, requestId: retryOf, retryable: true }
          : { ...current, retryable: payload.retryable === true }) : current);

      if (!ok) {
        await refreshUsageSummary();
        const providerErrors = payload.errors?.length
          ? `\n${payload.errors.map((item) => `${item.provider}: ${item.message}`).join("\n")}`
          : "";
        throw new Error(`${payload.error ?? "Unable to fetch consensus."}${providerErrors}`);
      }

      setUsageSummary((current) => current && payload.usage
        ? { ...current, creditsRemaining: payload.usage.creditsRemaining, creditsUsed: current.includedCredits - payload.usage.creditsRemaining }
        : current);
      void refreshUsageSummary();
      setStatusText(payload.responses.length === 1 ? `Answer ready from ${payload.responses[0].provider}.` : payload.errors?.length ? "Consensus ready with provider errors." : "Consensus ready.");
      setSessions((current) => current.map((session) => {
        if (session.id !== sessionId) return session;
        const assistantMessage: ChatTurn = {
          role: "assistant",
          content: payload.consensus || "Here is the synthesized consensus.",
          result: payload,
        };

        return { ...session, chat: [...requestMessages, assistantMessage], result: payload };
      }));
    } catch (submitError) {
      if (controller.signal.aborted || generationController.current !== controller) return;
      setError(submitError instanceof Error ? submitError.message : "Something went wrong.");
      setStatusText("The request failed. Please try again.");
    } finally {
      if (generationController.current === controller) { generationController.current = null; setIsLoading(false); }
    }
  }

  async function attachFiles(files: File[], projectId?: string) {
    if (!files.length || isLoading || readingFilesRef.current) return;
    readingFilesRef.current = true;
    setIsReadingFiles(true);
    setAttachmentError(null);
    const generation = draftGeneration.current;
    try {
      const project = projectId ? projects.find(p => p.id === projectId) : undefined;
      if (projectId && !project) throw new Error("Project not found.");
      const images = project ? project.files.flatMap(file => file.images) : [...pastedImages];
      const documents = project ? project.files.flatMap(file => file.documents) : [...attachedDocuments];
      const newProjectFiles: ProjectFile[] = [];
      if (files.length + images.length + documents.length > 8) throw new Error("Attach up to 4 images and 4 documents.");
      for (const file of files) {
        const imageStart = images.length;
        const documentStart = documents.length;
        const type = classifyFile(file);
        if (type.kind === "office") {
          const { readOfficeFile } = await import("@/lib/office-attachments");
          documents.push({ name: file.name, text: await readOfficeFile(file) });
        } else if (type.kind === "pdf") {
          const { renderPdf } = await import("@/lib/pdf-attachments");
          const pdf = await renderPdf(file, 4 - images.length, () => generation !== draftGeneration.current);
          images.push(...pdf.images);
          if (pdf.reference) documents.push({ ...pdf.reference, text: "" });
        } else if (type.kind === "image") {
          const dataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
            reader.readAsDataURL(new Blob([file], { type: type.mimeType }));
          });
          images.push({ dataUrl, mimeType: type.mimeType, name: file.name });
        } else {
          const text = await file.text();
          if (!text.trim() || text.includes("\0")) throw new Error(`${file.name} does not contain readable text.`);
          documents.push({ name: file.name, text });
        }
        if (project) newProjectFiles.push({ id: crypto.randomUUID(), name: file.name, images: images.slice(imageStart), documents: documents.slice(documentStart) });
      }
      validateAttachments(project ? "" : input, images, documents);
      if (project) {
        const nextFiles = [...project.files, ...newProjectFiles];
        prepareProjectMessages([{ role: "user", content: "Reference these project files" }], nextFiles);
        await saveProjectFiles(project.id, nextFiles);
        return;
      }
      if (generation !== draftGeneration.current) return;
      setPastedImages(images);
      setAttachedDocuments(documents);
    } catch (error) {
      if (generation === draftGeneration.current) setAttachmentError(error instanceof Error ? error.message : "Unable to read files.");
    } finally {
      readingFilesRef.current = false;
      setIsReadingFiles(false);
    }
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!userId) { setError(guestError || "Preparing your free session. Please try again in a moment."); return; }
    const trimmed = input.trim();
    if ((!trimmed && !pastedImages.length && !attachedDocuments.length) || isLoading || readingFilesRef.current || !activeSession) return;
    try {
      validateAttachments(trimmed, pastedImages, attachedDocuments);
      prepareProjectMessages([...chat, { role: "user", content: attachmentPrompt(trimmed, attachedDocuments), images: pastedImages, referenceDocuments: attachedDocuments.filter(file => file.pages).map(file => ({ name: file.name, pages: file.pages! })) }], activeProject?.files ?? []);
    }
    catch (error) { setAttachmentError(error instanceof Error ? error.message : "Invalid attachments."); return; }

    const userTurn: ChatTurn = { role: "user", content: attachmentPrompt(trimmed, attachedDocuments), displayContent: trimmed, attachedFileNames: attachedDocuments.map(file => file.name), images: pastedImages, referenceDocuments: attachedDocuments.filter(file => file.pages).map(file => ({ name: file.name, pages: file.pages! })) };
    const requestMessages = [...chat, userTurn];
    const requestId = crypto.randomUUID();
    setLastRequest({ messages: requestMessages, userTurn, sessionId: activeSession.id, requestId });

    setSessions((current) => current.map((session) => session.id === activeSession.id
      ? {
          ...session,
          chat: [...session.chat, userTurn],
          result: null,
          title: session.title === "New chat" ? (trimmed || attachedDocuments[0]?.name || pastedImages[0]?.name || "Image question").slice(0, 42) : session.title,
        }
      : session));
    setInput("");
    setPastedImages([]);
    setAttachedDocuments([]);
    setAttachmentError(null);
    draftGeneration.current += 1;
    setError(null);
    setIsLoading(true);
    setStatusText(`Asking ${getEnabledProviderLabel(settings)}…`);
    await runRequest(requestMessages, activeSession.id, requestId);
  }

  async function retryLastRequest() {
    if (!lastRequest || lastRequest.sessionId !== activeChatId || isLoading) return;
    const requestId = crypto.randomUUID();
    setLastRequest({ ...lastRequest, requestId, retryable: false });
    setError(null);
    setIsLoading(true);
    setStatusText("Trying again…");
    await runRequest(lastRequest.messages, lastRequest.sessionId, requestId, settings, lastRequest.retryable ? lastRequest.requestId : undefined);
  }

  function changeModel(provider: ProviderName, model: string) {
    setSettings(current => ({ ...current, [provider]: { ...current[provider], model } }));
  }

  async function rerunAnswer(answerIndex: number) {
    if (isLoading || !activeSession) return;
    const answer = chat[answerIndex];
    const messages = chat.slice(0, answerIndex);
    const userTurn = messages[messages.length - 1];
    if (!answer?.result || userTurn?.role !== "user") return;
    const requestId = crypto.randomUUID();
    setLastRequest({ messages, userTurn, sessionId: activeSession.id, requestId, retryable: false });
    setError(null);
    setIsLoading(true);
    setStatusText("Rerunning with selected models…");
    await runRequest(messages, activeSession.id, requestId, settings,
      answer.result.retryable ? answer.result.requestId : undefined);
  }

  function openProject(projectId: string | null) {
    setSelectedProjectId(projectId);
    const existing = sessions.find(session => (session.project_id ?? null) === projectId);
    if (existing) setActiveChatId(existing.id);
    else {
      const session = { ...createChatSession(), project_id: projectId };
      setSessions(current => [session, ...current]);
      setActiveChatId(session.id);
    }
    setLastRequest(null);
    setInput("");
    setError(null);
  }

  async function createProject(chatToMove?: string) {
    if (projectBusy || isLoading || isReadingFiles) return;
    const name = window.prompt("Project name")?.trim().slice(0, 100);
    if (!name || !userId || !projectReady) return;
    setProjectBusy(true);
    const project: Project = { id: crypto.randomUUID(), name, files: [] };
    const { error } = await supabase.from("projects").insert({ ...project, user_id: userId });
    setProjectBusy(false);
    if (error) { setProjectError(error.message); return; }
    setProjects(current => [...current, project]);
    setProjectError("");
    setExpandedFolders(current => [...current, project.id]);
    if (chatToMove) {
      setSessions(current => current.map(session => session.id === chatToMove ? { ...session, project_id: project.id } : session));
      if (chatToMove === activeChatId) {
        setSelectedProjectId(project.id);
        setLastRequest(null);
      }
      setChatMenu(null);
    } else {
      openProject(project.id);
    }
  }

  async function renameProject(project: Project) {
    const name = window.prompt("Project name", project.name)?.trim().slice(0, 100);
    if (!name) return;
    setProjectBusy(true);
    const { error } = await supabase.from("projects").update({ name, updated_at: new Date().toISOString() }).eq("id", project.id).eq("user_id", userId);
    setProjectBusy(false);
    if (error) { setProjectError(error.message); return; }
    setProjects(current => current.map(p => p.id === project.id ? { ...p, name } : p));
  }

  async function deleteProject(project: Project) {
    if (projectBusy || isLoading || isReadingFiles || !userId || !projectReady) return;
    if (!window.confirm(`Delete project "${project.name}"? Its chats will move to Chats. Shared project files will be removed.`)) return;
    setProjectBusy(true);
    setProjectError("");
    try {
      // The foreign key moves all project chats to the root atomically, including chats on other devices.
      const { data, error } = await supabase.from("projects").delete().eq("id", project.id).eq("user_id", userId).select("id");
      if (error) throw error;
      if (!data?.length) throw new Error("Project was not deleted. Refresh and try again.");
      setProjects(current => current.filter(p => p.id !== project.id));
      setSessions(current => current.map(session => session.project_id === project.id ? { ...session, project_id: null } : session));
      setExpandedFolders(current => current.filter(id => id !== project.id));
      if (selectedProjectId === project.id) {
        setSelectedProjectId(null);
        setLastRequest(null);
      }
    } catch (error) {
      setProjectError(error instanceof Error ? error.message : "Could not delete project. Please try again.");
    } finally {
      setProjectBusy(false);
    }
  }

  async function saveProjectFiles(projectId: string, files: ProjectFile[]) {
    const { error } = await supabase.from("projects").update({ files, updated_at: new Date().toISOString() }).eq("id", projectId).eq("user_id", userId);
    if (error) throw new Error(`Project files could not be saved: ${error.message}`);
    setProjects(current => current.map(p => p.id === projectId ? { ...p, files } : p));
    setProjectError("");
  }

  async function removeProjectFile(id: string) {
    if (!activeProject || !window.confirm("Remove this shared file from the project? Future messages in all its chats will no longer use it.")) return;
    setProjectBusy(true);
    try { await saveProjectFiles(activeProject.id, activeProject.files.filter(file => file.id !== id)); }
    catch (error) { setProjectError(error instanceof Error ? error.message : "Could not remove file."); }
    finally { setProjectBusy(false); }
  }

  function startNewChat() {
    const newSession = { ...createChatSession(), project_id: selectedProjectId };
    setLastRequest(null);
    setSessions((current) => [newSession, ...current]);
    setActiveChatId(newSession.id);
    setInput("");
    setError(null);
    setStatusText("Ready to compare model responses.");
  }

  function renameChat(session: ChatSession) {
    const nextTitle = window.prompt("Rename chat", session.title);
    if (!nextTitle?.trim()) return;
    setSessions((current) => current.map((item) => item.id === session.id ? { ...item, title: nextTitle.trim().slice(0, 60) } : item));
  }

  function switchProfile(profile: SettingsProfile) {
    setActiveProfileId(profile.id);
    setProfileName(profile.name);
    setSettings(profile.settings);
    setProfileNameError("");
  }

  function saveNewProfile() {
    const name = getUniqueProfileName(profileName, profiles);
    const profile = createSettingsProfile(name, settings);
    setProfiles((current) => ensureUniqueProfileNames([...current, profile]));
    setActiveProfileId(profile.id);
    setProfileName(name);
    setProfileNameError("");
  }

  async function startCheckout(purchase: "premium" | "topup" = "premium") {
    if (isGuest) { setShowAccountForm(true); setAuthMode("signup"); setShowSettings(true); return; }
    if (billingBusy) return;
    setBillingBusy(true);
    setProfileSyncError("");
    try {
      const response = await authenticatedFetch("/api/billing/checkout", {
        method: "POST",
        body: JSON.stringify(purchase === "topup" ? { purchase } : { planId: "premium" }),
      });
      const payload = await response.json() as { url?: string; error?: string };
      if (!response.ok || !payload.url) throw new Error(payload.error ?? "Checkout is unavailable.");
      window.location.assign(payload.url);
    } catch (checkoutError) {
      setProfileSyncError(checkoutError instanceof Error ? checkoutError.message : "Checkout is unavailable.");
    } finally {
      setBillingBusy(false);
    }
  }

  async function openBillingPortal() {
    if (billingBusy) return;
    setBillingBusy(true);
    setProfileSyncError("");
    try {
      const response = await authenticatedFetch("/api/billing/portal", { method: "POST", body: "{}" });
      const payload = await response.json() as { url?: string; error?: string };
      if (!response.ok || !payload.url) throw new Error(payload.error ?? "Billing portal is unavailable.");
      window.location.assign(payload.url);
    } catch (portalError) {
      setProfileSyncError(portalError instanceof Error ? portalError.message : "Billing portal is unavailable.");
    } finally {
      setBillingBusy(false);
    }
  }

  function deleteProfile() {
    if (profiles.length <= 1) return;
    const profile = profiles.find((item) => item.id === activeProfileId);
    if (!profile || !window.confirm(`Delete profile "${profile.name}"?`)) return;
    const remaining = profiles.filter((item) => item.id !== activeProfileId);
    const nextProfile = remaining[0];
    setProfiles(remaining);
    setActiveProfileId(nextProfile.id);
    setProfileName(nextProfile.name);
    setSettings(nextProfile.settings);
    if (userEmail) {
      authenticatedFetch("/api/settings/profiles", {
        method: "DELETE",
        body: JSON.stringify({ id: activeProfileId }),
      }).then(async (response) => {
        if (!response.ok) {
          const payload = await response.json() as { error?: string };
          setProfileSyncError(payload.error ?? "Profile delete error.");
        }
      }).catch(() => setProfileSyncError("Profile delete error. Check your connection."));
    }
  }

  async function handleAuth(event: FormEvent) {
    event.preventDefault();
    if (authBusy) return;
    setAuthBusy(true);
    setAuthError("");
    setAuthNotice("");
    try {
      const result = authMode === "login"
        ? await supabase.auth.signInWithPassword({ email: authEmail, password: authPassword })
        : await supabase.auth.signUp({ email: authEmail, password: authPassword });
      if (result.error) setAuthError(result.error.message);
      else {
        setAuthPassword("");
        if (result.data.session && !result.data.session.user.is_anonymous) { setShowSettings(false); setShowAccountForm(false); }
        else setAuthNotice("Check your email to confirm your account, then sign in to start chatting.");
      }
    } catch {
      setAuthError("Could not connect. Please try again.");
    } finally {
      setAuthBusy(false);
    }
  }

  async function signOut() {
    await supabase.auth.signOut();
    const signedOutProfile = createSettingsProfile("Default");
    window.localStorage.removeItem(PROFILES_KEY);
    window.localStorage.removeItem(SETTINGS_KEY);
    setProfiles([signedOutProfile]);
    setActiveProfileId(signedOutProfile.id);
    setProfileName(signedOutProfile.name);
    setSettings(signedOutProfile.settings);
    setUsageSummary(null);
    setProfileSyncError("");
    window.localStorage.removeItem(CHAT_HISTORY_KEY);
    const signedOutChat = createChatSession();
    setSessions([signedOutChat]);
    setActiveChatId(signedOutChat.id);
    setSelectedProjectId(null);
    setProjects([]);
    setProjectReady(false);
    setUserEmail("");
    setUserId("");
    setIsGuest(true);
    await ensureBrowserSession().catch(() => setGuestError("Guest access is unavailable. Please sign in or try again later."));
  }

  function deleteChat(session: ChatSession) {
    if (!window.confirm(`Delete "${session.title}"?`)) return;

    const remaining = sessions.filter((item) => item.id !== session.id);
    if (!remaining.length) {
      const newSession = { ...createChatSession(), project_id: selectedProjectId };
      setSessions([newSession]);
      setActiveChatId(newSession.id);
    } else {
      setSessions(remaining);
      if (session.id === activeChatId) {
        setActiveChatId(remaining[0].id);
        setSelectedProjectId(remaining[0].project_id ?? null);
      }
    }
    if (userId) {
      supabase.from("chat_sessions").delete().eq("id", session.id).eq("user_id", userId).then(({ error: deleteError }) => {
        if (deleteError) setProfileSyncError(`Chat delete error: ${deleteError.message}`);
      });
    }
    setInput("");
                  setPastedImages([]);
                  setAttachedDocuments([]);
                  setAttachmentError(null);
                  draftGeneration.current += 1;
    setError(null);
    setStatusText("Ready to compare model responses.");
  }

  const navigationBusy = isLoading || isReadingFiles || projectBusy;
  const folderIcon = <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /></svg>;
  function moveChat(chatId: string, projectId: string | null) {
    if (navigationBusy || !projectReady || !sessions.some(s => s.id === chatId) || (projectId && !projects.some(p => p.id === projectId))) return;
    setSessions(current => current.map(session => session.id === chatId ? { ...session, project_id: projectId } : session));
    if (chatId === activeChatId) {
      setSelectedProjectId(projectId);
      setLastRequest(null);
    }
    if (projectId) setExpandedFolders(current => current.includes(projectId) ? current : [...current, projectId]);
    setChatMenu(null);
    setDropFolder(null);
    setDraggedChat(null);
  }
  function folderDropHandlers(projectId: string | null) {
    return {
      onDragOver: (event: React.DragEvent) => {
        if (!draggedChat || navigationBusy || !projectReady) return;
        event.preventDefault(); event.dataTransfer.dropEffect = "move";
        setDropFolder(projectId ?? "personal");
      },
      onDragLeave: () => setDropFolder(null),
      onDrop: (event: React.DragEvent) => {
        event.preventDefault();
        if (draggedChat && event.dataTransfer.getData("application/x-consensus-chat") === draggedChat) moveChat(draggedChat, projectId);
        setDropFolder(null);
      },
    };
  }
  function showChatMenu(id: string, x: number, y: number) {
    setChatMenuPosition({ left: Math.max(8, Math.min(x || 16, window.innerWidth - 276)), top: Math.max(8, Math.min(y || 120, window.innerHeight - 320)) });
    setChatMenu(id);
  }
  function renderChat(session: ChatSession) {
    return <div key={session.id} className={`${styles.historyItem} ${session.id === activeChatId ? styles.activeHistoryItem : ""}`}
      draggable={!navigationBusy && projectReady}
      onDragStart={event => { event.dataTransfer.setData("application/x-consensus-chat", session.id); event.dataTransfer.effectAllowed = "move"; setDraggedChat(session.id); }}
      onDragEnd={() => { setDraggedChat(null); setDropFolder(null); }}
      onContextMenu={event => { event.preventDefault(); if (!navigationBusy) showChatMenu(session.id, event.clientX, event.clientY); }}>
      <button type="button" className={styles.historySelect} disabled={navigationBusy} title={session.title} onClick={() => {
        setActiveChatId(session.id); setSelectedProjectId(session.project_id ?? null); setError(null); setInput("");
      }}>{session.title}</button>
      <button type="button" className={styles.folderAction} disabled={navigationBusy} aria-label={`Actions for ${session.title}`} title="Chat actions" onClick={event => showChatMenu(session.id, event.clientX, event.clientY)}>⋯</button>
    </div>;
  }

  return (
    <main className={`${styles.shell} ${isDark ? styles.dark : styles.light}`}>
      <aside className={styles.sidebar}>
        <div className={styles.sidebarTop}>
          <div className={styles.brandWrap}>
            <div className={styles.logoBadge}>C</div>
            <div>
              <p className={styles.brandEyebrow}>Consensus</p>
              <h1>AI</h1>
            </div>
          </div>
          <div className={styles.actionRow}>
            <button type="button" className={`${styles.newChatButton} ${styles.sidebarIconButton}`} onClick={startNewChat} aria-label="New chat" title="New chat">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>
            <button type="button" className={`${styles.themeButton} ${styles.sidebarIconButton}`} onClick={() => setIsDark((current) => !current)} aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"} title={isDark ? "Switch to light theme" : "Switch to dark theme"}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                {isDark ? <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" /></> : <path d="M21 13a9 9 0 1 1-10-10 7 7 0 0 0 10 10Z" />}
              </svg>
            </button>
            <button type="button" className={`${styles.themeButton} ${styles.sidebarIconButton}`} onClick={() => setShowSettings((current) => !current)} aria-label={showSettings ? "Close settings" : "Settings"} title={showSettings ? "Close settings" : "Settings"} aria-expanded={showSettings}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="m9 3-.5 2-2 1L4.5 5.5l-2 3.5L4 10.5v3L2.5 15l2 3.5 2-.5 2 1 .5 2h6l.5-2 2-1 2 .5 2-3.5-1.5-1.5v-3L21.5 9l-2-3.5-2 .5-2-1-.5-2Z" /><circle cx="12" cy="12" r="3" />
              </svg>
            </button>
          </div>
        </div>
        {(error || profileSyncError || guestError) && <div className={styles.sidebarCard} role="alert">
          <p className={styles.mutedLabel}>Error</p>
          <p className={styles.statusLine}>{error || profileSyncError || guestError}</p>
        </div>}
        <nav className={styles.folderTree} aria-label="Chats and project folders">
          <div className={styles.historyHeader}>
            <p className={styles.mutedLabel}>Projects</p>
            <button type="button" className={styles.folderAction} title="New project folder" aria-label="New project folder"
              disabled={!projectReady || projectBusy || isLoading || isReadingFiles} onClick={() => void createProject()}>
              {folderIcon}<span aria-hidden="true">+</span>
            </button>
          </div>
          {projects.map(project => {
            const expanded = expandedFolders.includes(project.id);
            return <div key={project.id}>
              <div className={styles.folderHeading} {...folderDropHandlers(project.id)}>
              <button type="button" className={`${styles.folderRow} ${selectedProjectId === project.id ? styles.activeHistoryItem : ""} ${dropFolder === project.id ? styles.folderDrop : ""}`}
                aria-expanded={expanded} disabled={navigationBusy} title={project.name}
                onClick={() => {
                  setExpandedFolders(current => expanded ? current.filter(id => id !== project.id) : [...current, project.id]);
                  if (!expanded) openProject(project.id);
                }}>
                {folderIcon}<span>{project.name}</span><small aria-hidden="true">{expanded ? "⌄" : "›"}</small>
              </button>
              <button type="button" className={styles.folderAction} disabled={navigationBusy} title="Rename folder" aria-label={`Rename folder ${project.name}`} onClick={() => void renameProject(project)}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="m16 3 5 5L8 21H3v-5ZM14 5l5 5" />
                </svg>
              </button>
              <button type="button" className={`${styles.folderAction} ${styles.dangerAction}`} disabled={navigationBusy} title="Delete project" aria-label={`Delete project ${project.name}`} onClick={() => void deleteProject(project)}>
                <TrashIcon />
              </button>
              </div>
              {expanded && <div className={styles.folderContents}>
                {sessions.filter(session => session.project_id === project.id).map(renderChat)}
                {!sessions.some(session => session.project_id === project.id) && <p className={styles.settingsNote}>Drop a chat here</p>}
                {activeProject?.id === project.id && <details className={styles.folderTools}>
                  <summary>Project files</summary>
                  <button type="button" className={`${styles.profileButton} ${styles.projectUploadButton}`} disabled={navigationBusy} onClick={() => projectFileInputRef.current?.click()} aria-label="Upload shared files" title="Upload shared files"><UploadIcon /></button>
                  <input hidden ref={projectFileInputRef} type="file" accept={FILE_ACCEPT} multiple onChange={event => {
                    void attachFiles(Array.from(event.target.files ?? []), project.id);
                    event.target.value = "";
                  }} />
                  <ul className={styles.projectFiles}>
                    {project.files.map(file => <li key={file.id}><span>{file.name}</span><button type="button" className={`${styles.folderAction} ${styles.dangerAction}`} disabled={navigationBusy} title="Remove shared file" aria-label={`Remove shared file ${file.name}`} onClick={() => void removeProjectFile(file.id)}><TrashIcon /></button></li>)}
                  </ul>
                </details>}
              </div>}
            </div>;
          })}
          {projectError && <p role="alert" className={styles.authError}>{projectError}</p>}
          <button type="button" className={`${styles.folderRow} ${styles.personalChats} ${dropFolder === "personal" ? styles.folderDrop : ""}`}
            disabled={navigationBusy} onClick={() => openProject(null)} {...folderDropHandlers(null)}>Chats</button>
          {sessions.filter(session => !session.project_id).map(renderChat)}
        </nav>
      </aside>

      {chatMenu && <div className={styles.chatMenuBackdrop} onClick={() => setChatMenu(null)} onKeyDown={event => {
        if (event.key === "Escape") { event.preventDefault(); setChatMenu(null); }
      }}>
        <div ref={chatMenuRef} className={styles.chatMenu} style={{ ...chatMenuPosition, maxHeight: `calc(100dvh - ${chatMenuPosition.top + 12}px)` }} role="dialog" aria-label="Chat actions" onClick={event => event.stopPropagation()}>
          <div className={styles.historyHeader}><strong>Move chat to</strong><button type="button" className={styles.folderAction} aria-label="Close chat actions" onClick={() => setChatMenu(null)}>×</button></div>
          {[{ id: null, name: "Chats" }, ...projects].map(project => <button key={project.id ?? "personal"} type="button" className={styles.folderRow}
            disabled={navigationBusy || !projectReady || (sessions.find(s => s.id === chatMenu)?.project_id ?? null) === project.id}
            onClick={() => moveChat(chatMenu, project.id)}>{folderIcon}<span>{project.name}</span></button>)}
          <button type="button" className={styles.folderRow} disabled={navigationBusy || !projectReady} onClick={() => void createProject(chatMenu)}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
            <span>New project…</span>
          </button>
          <div className={styles.actionRow}>
      <button type="button" className={styles.folderAction} disabled={navigationBusy} title="Rename chat" aria-label="Rename chat" onClick={() => { const session = sessions.find(s => s.id === chatMenu); setChatMenu(null); if (session) renameChat(session); }}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m16 3 5 5L8 21H3v-5ZM14 5l5 5" />
        </svg>
      </button>
      <button type="button" className={`${styles.folderAction} ${styles.dangerAction}`} disabled={navigationBusy} title="Delete chat" aria-label="Delete chat" onClick={() => { const session = sessions.find(s => s.id === chatMenu); setChatMenu(null); if (session) deleteChat(session); }}>
        <TrashIcon />
      </button>
          </div>
        </div>
      </div>}

      {showSettings && (
        <div className={styles.settingsBackdrop} onMouseDown={() => setShowSettings(false)}>
          <div className={styles.settingsPanel} role="dialog" aria-modal="true" aria-labelledby="settings-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className={styles.settingsHeader}>
              <div>
                <h2 id="settings-title">{userId ? "Settings" : "Welcome to Consensus"}</h2>
              </div>
              <button type="button" className={styles.settingsCloseButton} onClick={() => setShowSettings(false)} aria-label="Close settings">
                ×
              </button>
            </div>
            <div className={styles.settingsContent}>
          {usageSummary && userId && (
            <section className={styles.usageCard} aria-label="Your plan">
              <div><strong>{usageSummary.plan === "free" ? "Free" : "Premium"}</strong></div>


              {usageSummary.plan !== "free" && !["active", "trialing"].includes(usageSummary.subscriptionStatus) && <p>Update your payment details to resume chatting.</p>}
              <div className={styles.billingActions}>
                {usageSummary.topupAvailable && <div>
                  <p>You’ve reached your monthly limit. Add extra usage for a one-time CA$4.20, or wait until {new Date(usageSummary.periodEnd).toLocaleDateString()}.</p>
                  <button type="button" className={styles.profileButton} disabled={billingBusy} onClick={() => void startCheckout("topup")}>{billingBusy ? "Opening…" : "Add usage · CA$4.20"}</button>
                  <p className={styles.settingsNote}>Valid until your monthly allowance resets. Your subscription stays the same.</p>
                </div>}
                {usageSummary.hasBillingAccount && <button type="button" className={styles.profileButton} disabled={billingBusy} onClick={openBillingPortal}>{billingBusy ? "Opening…" : "Manage subscription"}</button>}
              </div>
            </section>
          )}
          <p className={styles.settingsNote}>{userEmail ? "Your preferences and chats sync across browsers." : "Start chatting for free. No signup needed."}</p>
          {profileSyncError && <p className={styles.authError}>{profileSyncError}</p>}
          {userEmail ? (
            <div className={styles.accountRow}>
              <span>{userEmail}</span>
              <button type="button" className={`${styles.profileButton} ${styles.logoutButton}`} onClick={signOut}>Sign out</button>
            </div>
          ) : showAccountForm ? (
            <form className={styles.authForm} onSubmit={handleAuth}>
              <p className={styles.settingsNote}>An account is only needed for Premium or to access your chats on another device.</p>
              <input className={styles.settingsInput} type="email" value={authEmail} onChange={(event) => setAuthEmail(event.target.value)} placeholder="Email" required />
              <input className={styles.settingsInput} type="password" value={authPassword} onChange={(event) => setAuthPassword(event.target.value)} placeholder="Password" minLength={6} required />
              {authError && <p className={styles.authError}>{authError}</p>}
              {authNotice && <p role="status">{authNotice}</p>}
              <button type="submit" className={styles.profileButton} disabled={authBusy}>{authBusy ? "Please wait…" : authMode === "login" ? "Sign in" : "Create free account"}</button>
              <button type="button" className={styles.authSwitch} onClick={() => setAuthMode((current) => current === "login" ? "signup" : "login")}>
                {authMode === "login" ? "Create an account" : "Already have an account? Sign in"}
              </button>
              <button type="button" className={styles.authSwitch} onClick={() => setShowAccountForm(false)}>Continue as guest</button>
            </form>
          ) : (
            <div className={styles.accountRow}><span>Browsing as a guest</span><button type="button" className={styles.profileButton} onClick={() => { setShowAccountForm(true); setAuthMode("login"); }}>Sign in</button></div>
          )}
          {userId && <section className={styles.settingsContent} aria-labelledby="model-choices-title">
            <h3 id="model-choices-title">Models</h3>
          <p className={styles.settingsNote}>Choose one provider for a normal chat, or several to compare answers. Changes apply to your next message. To repeat a question, choose “Rerun with selected models” below its answer.</p>
          {(["GPT", "Gemini", "Claude"] as ProviderName[]).map((provider) => {
            const modelIds = modelCatalog[provider];
            return (
            <div key={provider} className={styles.providerSetting}>
              <label className={styles.providerCheck}>
                <input
                  type="checkbox"
                  checked={settings[provider].enabled}
                  disabled={settings[provider].enabled && Object.values(settings).filter((value) => typeof value === "object" && value.enabled).length <= 1 || isLoading}
                  onChange={(event) => setSettings((current) => ({
                    ...current,
                    [provider]: { ...current[provider], enabled: event.target.checked },
                  }))}
                />
                {provider}
              </label>
              <select
                className={styles.settingsInput}
                value={settings[provider].model}
                onChange={(event) => void changeModel(provider, event.target.value)}
                aria-label={`${provider} model`}
                disabled={isLoading}
              >
                {modelIds.map((modelId) => <option key={modelId} value={modelId}>{modelId}</option>)}
              </select>
              {modelDiscoveryErrors[provider] && <p className={styles.authError}>{modelDiscoveryErrors[provider]}</p>}
            </div>
            );
          })}
          </section>}
          {userId && <details className={styles.advancedSettings}>
            <summary>Profiles and display preferences</summary>
            <div className={styles.settingsContent}>
            <div className={styles.historyHeader}>
              <p className={styles.mutedLabel}>Profile and providers</p>
            </div>
          <select
            className={styles.settingsInput}
            value={activeProfileId}
            onChange={(event) => {
              const profile = profiles.find((item) => item.id === event.target.value);
              if (profile) switchProfile(profile);
            }}
            aria-label="Settings profile"
          >
            {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
          </select>
          <input
            className={styles.settingsInput}
            value={profileName}
            onChange={(event) => {
              const nextName = event.target.value;
              const isDuplicate = profiles.some((profile) => (
                profile.id !== activeProfileId
                && profile.name.trim().toLocaleLowerCase() === nextName.trim().toLocaleLowerCase()
              ));
              if (isDuplicate) {
                setProfileNameError("A profile with that name already exists.");
                return;
              }
              setProfileNameError("");
              setProfileName(nextName);
            }}
            placeholder="Profile name"
            aria-label="Profile name"
          />
          {profileNameError && <p className={styles.authError}>{profileNameError}</p>}
          <div className={styles.profileActions}>
            <button type="button" className={styles.profileButton} onClick={saveNewProfile}>Save as new</button>
            <button type="button" className={`${styles.profileButton} ${styles.dangerAction}`} onClick={deleteProfile} disabled={profiles.length <= 1}>Delete profile</button>
          </div>
          <label className={styles.providerCheck}>
            <input
              type="checkbox"
              checked={settings.consensusDropdownDefaultOpen}
              onChange={(event) => setSettings((current) => ({
                ...current,
                consensusDropdownDefaultOpen: event.target.checked,
              }))}
            />
            Open consensus dropdowns by default
          </label>

            </div>
          </details>}
            </div>
          </div>
        </div>
      )}

      <section className={styles.chatArea}>
        <div className={styles.chatViewport} ref={viewportRef}>
          {chat.length === 0 && !result && (
            <div className={styles.emptyState}>
              <h2>One question. Multiple perspectives.</h2>
              <p>Compare AI answers in one place.</p>
              {isGuest && <><p className={styles.welcomeNote}>Start free · No signup needed</p><button type="button" className={styles.authSwitch} onClick={() => { setAuthMode("login"); setShowAccountForm(true); setShowSettings(true); }}>Sign in</button></>}
              {guestError && <p className={styles.authError} role="alert">{guestError}</p>}
            </div>
          )}

          {chat.map((message, index) => (
            <div key={`${message.role}-${index}`} className={`${styles.messageRow} ${message.role === "user" ? styles.userRow : styles.assistantRow}`}>
              <div className={styles.messageBubble}>
                <span className={styles.messageRole}>{message.role === "user" ? "You" : "Consensus"}</span>
                {(message.images ?? (message.image ? [message.image] : [])).map((image, imageIndex) => (
                  <img key={`${image.dataUrl}-${imageIndex}`} className={styles.messageImage} src={image.dataUrl} alt={`Pasted prompt image ${imageIndex + 1}`} />
                ))}
                {messageDisplay(message).files.length > 0 && <div className={styles.documentAttachments}>
                  {messageDisplay(message).files.map((name, fileIndex) => <span className={styles.documentChip} key={`${name}-${fileIndex}`}>
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                      <path d="M14 2H5v20h14V7l-5-5Zm0 0v5h5M8 12h8M8 16h8" />
                    </svg>
                    {name}
                  </span>)}
                </div>}
                {messageDisplay(message).text && <div className={styles.messageContent}><FormattedMarkdown>{messageDisplay(message).text}</FormattedMarkdown></div>}
                {message.role === "assistant" && message.result?.errors.some(item => item.provider !== "Comparison") ? (
                  <div className={styles.partialProviderWarning} role="status">
                    Incomplete response. {message.result.errors.filter(item => item.provider !== "Comparison").map((item) => `${item.provider}: ${item.message}`).join(" ")}
                    <button type="button" className={styles.profileButton} onClick={() => setShowSettings(true)}>Change models</button>
                  </div>
                ) : null}
                {message.role === "assistant" && message.result && (
                  <ConsensusDetails
                    result={message.result}
                    onRetry={() => void rerunAnswer(index)}
                    disabled={isLoading || index !== chat.length - 1}
                    defaultOpen={settings.consensusDropdownDefaultOpen}
                  />
                )}
              </div>
            </div>
          ))}

          {isLoading && (
            <div className={styles.loadingRow}>
              <div className={styles.loadingBubble} role="status" aria-live="polite" aria-atomic="true">
                <div className={styles.loader}>
                  <span className={styles.loadingGraphic} aria-hidden="true">
                    {generationDots(generationModelCount).map((dot, index) => <span key={index} className={styles.convergingDot}
                      style={{ "--dot-x": `${dot.x}px`, "--dot-y": `${dot.y}px` } as CSSProperties} />)}
                  </span>
                  <span>{generationLabel(generationPhase)}</span>
                </div>
              </div>
            </div>
          )}

          {error && (
            <div className={styles.errorCard}>
              <span className={styles.errorMessage}>{error}</span>
              {usageSummary?.topupAvailable ? <button type="button" className={styles.profileButton} disabled={billingBusy} onClick={() => setShowSettings(true)}>Add usage · CA$4.20</button> :
                userId && <button type="button" className={styles.profileButton} onClick={() => setShowSettings(true)}>View plan and settings</button>}
              {lastRequest && (
                <button type="button" className={styles.retryButton} onClick={retryLastRequest} disabled={isLoading}>
                  Try again
                </button>
              )}
            </div>
          )}

        </div>

        <form className={`${styles.composer} ${isDraggingFiles ? styles.composerDropActive : ""}`} onSubmit={handleSubmit}
          onDragEnter={event => {
            if (!event.dataTransfer.types.includes("Files")) return;
            event.preventDefault();
            dragDepth.current += 1;
            setIsDraggingFiles(true);
          }}
          onDragOver={event => {
            if (!event.dataTransfer.types.includes("Files")) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = isLoading || isReadingFiles ? "none" : "copy";
          }}
          onDragLeave={event => {
            event.preventDefault();
            dragDepth.current = Math.max(0, dragDepth.current - 1);
            if (!dragDepth.current) setIsDraggingFiles(false);
          }}
          onDrop={event => {
            event.preventDefault();
            dragDepth.current = 0;
            setIsDraggingFiles(false);
            void attachFiles(Array.from(event.dataTransfer.files));
          }}>
          <input ref={fileInputRef} type="file" accept={FILE_ACCEPT} multiple hidden
            onChange={event => {
              void attachFiles(Array.from(event.target.files ?? []));
              event.target.value = "";
            }} />
          {isDraggingFiles && <p className={styles.attachmentNotice}>Drop documents, spreadsheets, presentations or images here</p>}
          {isReadingFiles && <p className={styles.attachmentNotice} role="status">Reading files…</p>}
          {attachmentError && <p className={styles.attachmentNotice} role="alert">{attachmentError}</p>}
          {attachedDocuments.length > 0 && <div className={styles.documentAttachments}>
            {attachedDocuments.map((file, index) => <span key={`${file.name}-${index}`} className={styles.documentChip}>
              {file.name}{file.pages ? ` · ${file.pages.length} pages · text reference` : ""}
              <button type="button" disabled={isReadingFiles} aria-label={`Remove ${file.name}`} onClick={() => {
                setAttachedDocuments(current => current.filter((_, i) => i !== index));
                setAttachmentError(null);
              }}>×</button>
            </span>)}
          </div>}
          <textarea
            ref={composerRef}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            rows={1}
            className={styles.textarea}
            placeholder="Ask a question or paste a multiple-choice question…"
            onPaste={(event) => {
              const files = Array.from(event.clipboardData.files);
              if (!files.length) return;
              event.preventDefault();
              void attachFiles(files);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
          {pastedImages.length > 0 && (
            <div className={styles.imagePreviewList}>
              {pastedImages.map((image, imageIndex) => (
                <div key={`${image.dataUrl}-${imageIndex}`} className={styles.imagePreviewWrap}>
                  <img className={styles.imagePreview} src={image.dataUrl} alt={image.name ?? `Attached image ${imageIndex + 1}`} />
                  {image.name && <span className={styles.attachmentCaption}>{image.name}</span>}
                  <button type="button" className={styles.removeImageButton} disabled={isReadingFiles} onClick={() => setPastedImages((current) => current.filter((_, index) => index !== imageIndex))} aria-label={`Remove ${image.name ?? `attached image ${imageIndex + 1}`}`}>
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className={styles.composerActions}>
          <button type="button" className={styles.profileButton} disabled={isLoading || isReadingFiles}
            onClick={() => fileInputRef.current?.click()} aria-label="Upload files" title="Upload files">
            <UploadIcon />
          </button>
          <details className={styles.modelPicker} onKeyDown={event => {
            if (event.key === "Escape") {
              event.currentTarget.open = false;
              event.currentTarget.querySelector("summary")?.focus();
            }
          }}>
            <summary className={styles.modelPickerButton}>Models · {getEnabledProviderLabel(settings)}</summary>
            <fieldset className={styles.modelPickerMenu}>
              <legend>Models for your next message</legend>
              {(["GPT", "Gemini", "Claude"] as ProviderName[]).map(provider => (
                <div key={provider}>
                <div className={styles.modelPickerRow}>
                <label className={styles.providerCheck}>
                  <input type="checkbox" checked={settings[provider].enabled}
                    disabled={isLoading || (settings[provider].enabled &&
                      (["GPT", "Gemini", "Claude"] as ProviderName[]).filter(p => settings[p].enabled).length === 1)}
                    onChange={event => setSettings(current => ({
                      ...current, [provider]: { ...current[provider], enabled: event.target.checked },
                    }))} />
                  {provider}
                </label>
                <select className={styles.settingsInput} aria-label={`${provider} model for your next message`}
                  value={settings[provider].model} disabled={isLoading}
                  onChange={event => void changeModel(provider, event.target.value)}>
                  {modelCatalog[provider].map(modelId => <option key={modelId} value={modelId}>{modelId}</option>)}
                </select>
                </div>
                {modelDiscoveryErrors[provider] && <p className={styles.authError}>{modelDiscoveryErrors[provider]}</p>}
                </div>
              ))}
            </fieldset>
          </details>
          {isLoading ? <button type="button" className={styles.submitButton} onClick={() => {
            generationController.current?.abort(); generationController.current = null; setIsLoading(false); setError(null);
          }}>Stop</button> : <button type="submit" className={styles.submitButton} disabled={!authChecked || !userId || isLoading || isReadingFiles || (!input.trim() && !pastedImages.length && !attachedDocuments.length)}>
            {!authChecked ? "Getting ready…" : "Send"}
          </button>}
          </div>
        </form>
      </section>
    </main>
  );
}
