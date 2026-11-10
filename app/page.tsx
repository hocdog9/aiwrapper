"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkMath from "remark-math";
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
  role: "user" | "assistant";
  content: string;
  image?: {
    dataUrl: string;
    mimeType: string;
  };
  images?: Array<{ dataUrl: string; mimeType: string }>;
  result?: ResponsePayload;
};

type ResponsePayload = {
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
  usage: { creditCharged: number; creditsRemaining: number };
};

type ChatSession = {
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
};

type ProviderSettings = {
  enabled: boolean;
  model: string;
};

type AppSettings = Record<ProviderName, ProviderSettings> & {
  consensusDropdownDefaultOpen: boolean;
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

async function authenticatedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const { data } = await supabase.auth.getSession();
  const accessToken = data.session?.access_token;
  if (!accessToken) throw new Error("Sign in to continue.");
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${accessToken}`);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return fetch(path, { ...init, headers });
}

function FormattedMarkdown({ children }: { children: string }) {
  const normalized = children
    .replace(/\\\[([\s\S]*?)\\\]/g, "$$$$$1$$$$")
    .replace(/\\\(([\s\S]*?)\\\)/g, "$$$1$$");

  return (
    <ReactMarkdown remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex]}>
      {normalized}
    </ReactMarkdown>
  );
}

const defaultSettings: AppSettings = {
  GPT: { enabled: true, model: "gpt-4o-mini" },
  Gemini: { enabled: true, model: "gemini-3.8-flash" },
  Claude: { enabled: false, model: "claude-3-5-sonnet-20241022" },
  consensusDropdownDefaultOpen: false,
};

const fallbackModels: ModelCatalog = {
  GPT: ["gpt-4o-mini"],
  Gemini: ["gemini-3.8-flash"],
  Claude: ["claude-3-5-sonnet-20241022"],
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
      model: ["gemini-3.6-flash", "gemini-2.5-flash", "gemini-2.5-pro"].includes(stored.Gemini?.model ?? "")
        ? defaultSettings.Gemini.model
        : stored.Gemini?.model || defaultSettings.Gemini.model,
    },
    Claude: {
      enabled: stored.Claude?.enabled === true,
      model: stored.Claude?.model || defaultSettings.Claude.model,
    },
    consensusDropdownDefaultOpen: settings.consensusDropdownDefaultOpen === true,
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
  const [showClaims, setShowClaims] = useState(false);

  return (
    <div className={styles.consensusDetailsWrap}>
      <details className={styles.consensusDetails} open={defaultOpen}>
        <summary className={styles.consensusSummary}>
          <span>{result.agreementScore !== null ? `${result.agreementScore}% model agreement` : "Low agreement"}</span>
          <span className={styles.consensusSummaryText}>{result.summary}</span>
        </summary>

        <div className={styles.consensusBody}>
          <div className={styles.resultHeader}>
            <div>
              <p className={styles.mutedLabel}>Consensus</p>
              <h3>{result.agreementScore !== null ? `${result.agreementScore}% model agreement` : "Low agreement"}</h3>
            </div>
            <div className={styles.resultActions}>
              <span className={styles.agreementPill}>{result.summary}</span>
            </div>
          </div>

          <div className={styles.resultBody}><FormattedMarkdown>{result.consensus}</FormattedMarkdown></div>

          <div className={styles.metaGrid}>
            <div className={styles.metaCard}>
              <h4>Where they agree</h4>
              <ul>
                {result.agreements.length ? result.agreements.map((item) => <li key={item}><span className={styles.claimMarker}>✓</span><span className={styles.claimBody}><FormattedMarkdown>{item}</FormattedMarkdown></span></li>) : <li>Not enough shared evidence.</li>}
              </ul>
            </div>
            <div className={styles.metaCard}>
              <h4>Where they differ</h4>
              <ul>
                {result.disagreements.length ? result.disagreements.map((item) => <li key={item}><span className={styles.claimMarker}>!</span><span className={styles.claimBody}><FormattedMarkdown>{item}</FormattedMarkdown></span></li>) : <li>No material disagreements surfaced.</li>}
              </ul>
            </div>
          </div>

          <div className={styles.claimPanel}>
            <div className={styles.panelHeadRow}>
              <div>
                <h4>Claim consensus</h4>
                <span>{result.confidenceNote}</span>
              </div>
              <button
                type="button"
                className={styles.claimToggle}
                aria-expanded={showClaims}
                onClick={() => setShowClaims((current) => !current)}
              >
                {showClaims ? "Hide claims" : "Show claims"}
              </button>
            </div>
            {showClaims && (result.claims.length ? (
              <ul className={styles.claimList}>
                {result.claims.map((claim) => (
                  <li key={claim.claim} className={styles.claimItem}>
                    <span className={styles.claimBadge}>{claim.supportCount}/{claim.totalModels}</span>
                    <span className={styles.claimText}>{claim.claim}</span>
                    <span className={styles.claimStatus}>{claim.status}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className={styles.emptyNotes}>No discrete claim-level structure was extracted.</p>
            ))}
          </div>

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
        aria-label="Regenerate response"
        title="Regenerate response"
      >
        <span aria-hidden="true">↻</span>
      </button>
    </div>
  );
}

export default function Home() {
  const [input, setInput] = useState("");
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeChatId, setActiveChatId] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [statusText, setStatusText] = useState("Ready to compare model responses.");
  const [error, setError] = useState<string | null>(null);
  const [isDark, setIsDark] = useState(true);
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
  const [lastRequest, setLastRequest] = useState<{ messages: ChatTurn[]; userTurn: ChatTurn; sessionId: string; requestId: string } | null>(null);
  const activeSession = sessions.find((session) => session.id === activeChatId) ?? sessions[0];
  const chat = activeSession?.chat ?? EMPTY_CHAT;
  const result = activeSession?.result ?? null;

  useEffect(() => {
    let active = true;
    async function loadAccount() {
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
        setUserEmail("");
        setUserId("");
        setAuthChecked(true);
        return;
      }
      setUserEmail(data.user.email ?? "");
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
      const { data: remoteChats, error: chatError } = await supabase
        .from("chat_sessions")
        .select("id, title, chat, result")
        .order("updated_at", { ascending: false });
      if (chatError) {
        setProfileSyncError(`Chat history error: ${chatError.message}`);
      } else if (remoteChats?.length) {
        const nextSessions = remoteChats as ChatSession[];
        setSessions(nextSessions.map(hydrateSessionResults));
        setActiveChatId(nextSessions[0].id);
      } else {
        const firstSession = createChatSession();
        setSessions([firstSession]);
        setActiveChatId(firstSession.id);
      }
      setProfilesLoaded(true);
      setAuthChecked(true);
    }
    loadAccount();
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session?.user) {
        setAuthChecked(false);
        setUserEmail(session.user.email ?? "");
        setUserId(session.user.id);
        loadAccount();
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
    if (!userEmail) {
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
  }, [settings, profileName, activeProfileId, profilesLoaded, profiles, userEmail, authChecked]);

  useEffect(() => {
    if (authChecked && userEmail && sessions.length) {
      window.localStorage.setItem(CHAT_HISTORY_KEY, JSON.stringify(sessions));
      if (userId) {
        supabase.from("chat_sessions").upsert(sessions.map((session) => ({
          id: session.id,
          user_id: userId,
          title: session.title,
          chat: session.chat,
          result: session.result,
          updated_at: new Date().toISOString(),
        }))).then(({ error: saveError }) => {
          if (saveError) setProfileSyncError(`Chat history save error: ${saveError.message}`);
        });
      }
    }
  }, [authChecked, sessions, userEmail, userId]);

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
            const nextSettings = { ...current };
            for (const provider of ["GPT", "Gemini", "Claude"] as ProviderName[]) {
              const available = payload.models?.[provider] ?? [];
              if (!payload.loaded?.[provider] || !available.length || available.includes(current[provider].model)) continue;
              const preferred = available.find((model) => /flash|mini|haiku/i.test(model)) ?? available[0];
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

  async function runRequest(requestMessages: ChatTurn[], userTurn: ChatTurn, sessionId: string, requestId: string) {
    try {
      const response = await authenticatedFetch("/api/chat", {
        method: "POST",
        body: JSON.stringify({ messages: requestMessages, settings, requestId, conversationId: sessionId }),
      });

      const payload = (await response.json()) as ResponsePayload & { error?: string };

      if (!response.ok) {
        await refreshUsageSummary();
        const providerErrors = payload.errors?.length
          ? `\n${payload.errors.map((item) => `${item.provider}: ${item.message}`).join("\n")}`
          : "";
        throw new Error(`${payload.error ?? "Unable to fetch consensus."}${providerErrors}`);
      }

      setUsageSummary((current) => current && payload.usage
        ? { ...current, creditsRemaining: payload.usage.creditsRemaining, creditsUsed: current.includedCredits - payload.usage.creditsRemaining }
        : current);
      setStatusText(payload.errors?.length ? "Consensus ready with provider errors." : "Consensus ready.");
      setSessions((current) => current.map((session) => {
        if (session.id !== sessionId) return session;
        const currentChat = session.chat;
        const chatWithUserTurn = currentChat.some(
          (message) => message.role === "user" && message.content === userTurn.content
        )
          ? currentChat
          : [...currentChat, userTurn];
        const assistantMessage: ChatTurn = {
          role: "assistant",
          content: payload.consensus || "Here is the synthesized consensus.",
          result: payload,
        };

        const hasAssistantMessage = chatWithUserTurn.some(
          (message) => message.role === "assistant" && message.content === assistantMessage.content
        );

        return { ...session, chat: hasAssistantMessage ? chatWithUserTurn : [...chatWithUserTurn, assistantMessage], result: payload };
      }));
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Something went wrong.");
      setStatusText("The request failed. Please try again.");
    } finally {
      setIsLoading(false);
    }
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!userId) { setAuthMode("signup"); setShowSettings(true); return; }
    const trimmed = input.trim();
    if ((!trimmed && !pastedImages.length) || isLoading || !activeSession) return;

    const userTurn: ChatTurn = { role: "user", content: trimmed, images: pastedImages };
    const requestMessages = [...chat, userTurn];
    const requestId = crypto.randomUUID();
    setLastRequest({ messages: requestMessages, userTurn, sessionId: activeSession.id, requestId });

    setSessions((current) => current.map((session) => session.id === activeSession.id
      ? {
          ...session,
          chat: [...session.chat, userTurn],
          result: null,
          title: session.title === "New chat" ? trimmed.slice(0, 42) : session.title,
        }
      : session));
    setInput("");
    setPastedImages([]);
    setError(null);
    setIsLoading(true);
    setStatusText(`Asking ${getEnabledProviderLabel(settings)}…`);
    await runRequest(requestMessages, userTurn, activeSession.id, requestId);
  }

  async function retryLastRequest() {
    if (!lastRequest || isLoading) return;
    const requestId = crypto.randomUUID();
    setLastRequest({ ...lastRequest, requestId });
    setError(null);
    setIsLoading(true);
    setStatusText("Trying again…");
    await runRequest(lastRequest.messages, lastRequest.userTurn, lastRequest.sessionId, requestId);
  }

  function startNewChat() {
    const newSession = createChatSession();
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

  async function startCheckout() {
    if (billingBusy) return;
    setBillingBusy(true);
    setProfileSyncError("");
    try {
      const response = await authenticatedFetch("/api/billing/checkout", {
        method: "POST",
        body: JSON.stringify({ planId: "premium" }),
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
        if (result.data.session) setShowSettings(false);
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
    setUserEmail("");
    setUserId("");
  }

  function deleteChat(session: ChatSession) {
    if (!window.confirm(`Delete "${session.title}"?`)) return;

    const remaining = sessions.filter((item) => item.id !== session.id);
    if (!remaining.length) {
      const newSession = createChatSession();
      setSessions([newSession]);
      setActiveChatId(newSession.id);
    } else {
      setSessions(remaining);
      if (session.id === activeChatId) {
        setActiveChatId(remaining[0].id);
      }
    }
    if (userId) {
      supabase.from("chat_sessions").delete().eq("id", session.id).eq("user_id", userId).then(({ error: deleteError }) => {
        if (deleteError) setProfileSyncError(`Chat delete error: ${deleteError.message}`);
      });
    }
    setInput("");
                  setPastedImages([]);
    setError(null);
    setStatusText("Ready to compare model responses.");
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
            <button type="button" className={styles.newChatButton} onClick={startNewChat}>
              New chat
            </button>
            <button type="button" className={styles.themeButton} onClick={() => setIsDark((current) => !current)}>
              {isDark ? "Light" : "Dark"}
            </button>
            <button type="button" className={styles.themeButton} onClick={() => setShowSettings((current) => !current)}>
              {showSettings ? "Close settings" : "Settings"}
            </button>
          </div>
        </div>
        <div className={styles.sidebarCard}>
          <p className={styles.mutedLabel}>Current status</p>
          <p className={styles.statusLine}>{statusText}</p>
          {usageSummary && userId && <button type="button" className={styles.authSwitch} onClick={() => setShowSettings(true)}>{usageSummary.plan === "free" ? "Free" : "Premium"} · {usageSummary.creditsRemaining} requests left</button>}
        </div>
        <div className={styles.historyPanel}>
          <div className={styles.historyHeader}>
            <p className={styles.mutedLabel}>Chat history</p>
            <span>{sessions.length}</span>
          </div>
          <div className={styles.historyList}>
            {sessions.map((session) => (
              <div key={session.id} className={`${styles.historyItem} ${session.id === activeSession?.id ? styles.activeHistoryItem : ""}`}>
                <button type="button" className={styles.historySelect} onClick={() => {
                  setActiveChatId(session.id);
                  setError(null);
                  setInput("");
                }}>
                  {session.title}
                </button>
                <button type="button" className={styles.renameButton} onClick={() => renameChat(session)} aria-label={`Rename ${session.title}`}>
                  Edit
                </button>
                <button type="button" className={styles.deleteButton} onClick={() => deleteChat(session)} aria-label={`Delete ${session.title}`}>
                  Delete
                </button>
              </div>
            ))}
          </div>
        </div>
      </aside>

      {showSettings && (
        <div className={styles.settingsBackdrop} onMouseDown={() => setShowSettings(false)}>
          <div className={styles.settingsPanel} role="dialog" aria-modal="true" aria-labelledby="settings-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className={styles.settingsHeader}>
              <div>
                <p className={styles.mutedLabel}>Settings</p>
                <h2 id="settings-title">{userId ? "Settings" : "Welcome to Consensus"}</h2>
              </div>
              <button type="button" className={styles.settingsCloseButton} onClick={() => setShowSettings(false)} aria-label="Close settings">
                ×
              </button>
            </div>
            <div className={styles.settingsContent}>
          {usageSummary && userId && (
            <section className={styles.usageCard} aria-label="Your plan">
              <div><strong>{usageSummary.plan === "free" ? "Free" : "Premium"}</strong><span>{usageSummary.creditsRemaining} of {usageSummary.includedCredits} requests remaining</span></div>
              <p>Allowance resets {new Date(usageSummary.periodEnd).toLocaleDateString()}</p>
              {usageSummary.plan === "free" && <p>Need more? Premium includes 500 requests per month.</p>}
              {usageSummary.plan !== "free" && !["active", "trialing"].includes(usageSummary.subscriptionStatus) && <p>Update your payment details to resume chatting.</p>}
              <div className={styles.billingActions}>
                {usageSummary.plan === "free" && <button type="button" className={styles.profileButton} disabled={billingBusy} onClick={startCheckout}>{billingBusy ? "Opening…" : "Upgrade to Premium"}</button>}
                {usageSummary.hasBillingAccount && <button type="button" className={styles.profileButton} disabled={billingBusy} onClick={openBillingPortal}>{billingBusy ? "Opening…" : "Manage subscription"}</button>}
              </div>
            </section>
          )}
          <p className={styles.settingsNote}>{userEmail ? "Your preferences and chats sync across browsers." : "Start free with 10 requests per month. No credit card required."}</p>
          {profileSyncError && <p className={styles.authError}>{profileSyncError}</p>}
          {userEmail ? (
            <div className={styles.accountRow}>
              <span>{userEmail}</span>
              <button type="button" className={`${styles.profileButton} ${styles.logoutButton}`} onClick={signOut}>Sign out</button>
            </div>
          ) : (
            <form className={styles.authForm} onSubmit={handleAuth}>
              <p className={styles.settingsNote}>Create an account to ask your first question, or sign in to continue.</p>
              <input className={styles.settingsInput} type="email" value={authEmail} onChange={(event) => setAuthEmail(event.target.value)} placeholder="Email" required />
              <input className={styles.settingsInput} type="password" value={authPassword} onChange={(event) => setAuthPassword(event.target.value)} placeholder="Password" minLength={6} required />
              {authError && <p className={styles.authError}>{authError}</p>}
              {authNotice && <p role="status">{authNotice}</p>}
              <button type="submit" className={styles.profileButton} disabled={authBusy}>{authBusy ? "Please wait…" : authMode === "login" ? "Sign in" : "Create free account"}</button>
              <button type="button" className={styles.authSwitch} onClick={() => setAuthMode((current) => current === "login" ? "signup" : "login")}>
                {authMode === "login" ? "Create an account" : "Already have an account? Sign in"}
              </button>
            </form>
          )}
          {userId && <details className={styles.advancedSettings}>
            <summary>Customize models and preferences</summary>
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
            <button type="button" className={styles.profileButton} onClick={deleteProfile} disabled={profiles.length <= 1}>Delete profile</button>
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
          <p className={styles.settingsNote}>Choose at least two providers. We have selected defaults so you can start right away.</p>
          {(["GPT", "Gemini", "Claude"] as ProviderName[]).map((provider) => {
            const modelIds = modelCatalog[provider];
            return (
            <div key={provider} className={styles.providerSetting}>
              <label className={styles.providerCheck}>
                <input
                  type="checkbox"
                  checked={settings[provider].enabled}
                  disabled={settings[provider].enabled && Object.values(settings).filter((value) => typeof value === "object" && value.enabled).length <= 2}
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
                onChange={(event) => setSettings((current) => ({
                  ...current,
                  [provider]: { ...current[provider], model: event.target.value },
                }))}
                aria-label={`${provider} model`}
              >
                {modelIds.map((modelId) => <option key={modelId} value={modelId}>{modelId}</option>)}
              </select>
              {modelDiscoveryErrors[provider] && <p className={styles.authError}>{modelDiscoveryErrors[provider]}</p>}
            </div>
            );
          })}
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
              <h2>Ask once. Compare answers.</h2>
              <p>Get answers from multiple AI models and see where they agree.</p>
              {!userId && <><p>Start with 10 free requests per month. No credit card required.</p><button type="button" className={styles.profileButton} onClick={() => { setAuthMode("signup"); setShowSettings(true); }}>Get started free</button><button type="button" className={styles.authSwitch} onClick={() => { setAuthMode("login"); setShowSettings(true); }}>Already have an account? Sign in</button></>}
            </div>
          )}

          {chat.map((message, index) => (
            <div key={`${message.role}-${index}`} className={`${styles.messageRow} ${message.role === "user" ? styles.userRow : styles.assistantRow}`}>
              <div className={styles.messageBubble}>
                <span className={styles.messageRole}>{message.role === "user" ? "You" : "Consensus"}</span>
                {(message.images ?? (message.image ? [message.image] : [])).map((image, imageIndex) => (
                  <img key={`${image.dataUrl}-${imageIndex}`} className={styles.messageImage} src={image.dataUrl} alt={`Pasted prompt image ${imageIndex + 1}`} />
                ))}
                <div className={styles.messageContent}><FormattedMarkdown>{message.content}</FormattedMarkdown></div>
                {message.role === "assistant" && message.result?.errors.length ? (
                  <div className={styles.partialProviderWarning} role="status">
                    Partial provider response: {message.result.errors.map((item) => `${item.provider}: ${item.message}`).join(" ")}
                  </div>
                ) : null}
                {message.role === "assistant" && message.result && (
                  <ConsensusDetails
                    result={message.result}
                    onRetry={retryLastRequest}
                    disabled={isLoading}
                    defaultOpen={settings.consensusDropdownDefaultOpen}
                  />
                )}
              </div>
            </div>
          ))}

          {isLoading && (
            <div className={styles.loadingRow}>
              <div className={styles.loadingBubble}>
                <span className={styles.messageRole}>Working</span>
                <div className={styles.loader}>Asking {getEnabledProviderLabel(settings)}…</div>
              </div>
            </div>
          )}

          {error && (
            <div className={styles.errorCard}>
              <span className={styles.errorMessage}>{error}</span>
              {userId && <button type="button" className={styles.profileButton} onClick={() => setShowSettings(true)}>View plan and settings</button>}
              {lastRequest && (
                <button type="button" className={styles.retryButton} onClick={retryLastRequest} disabled={isLoading}>
                  Try again
                </button>
              )}
            </div>
          )}

        </div>

        <form className={styles.composer} onSubmit={handleSubmit}>
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            rows={1}
            className={styles.textarea}
            placeholder="Ask a question or paste a multiple-choice question…"
            onPaste={(event) => {
              const imageItem = Array.from(event.clipboardData.items).find((item) => item.type.startsWith("image/"));
              if (!imageItem) return;

              const file = imageItem.getAsFile();
              if (!file) return;

              event.preventDefault();
              const reader = new FileReader();
              reader.onload = () => {
                if (typeof reader.result === "string") {
                  setPastedImages((current) => [...current, { dataUrl: reader.result as string, mimeType: file.type }]);
                }
              };
              reader.readAsDataURL(file);
            }}
            onInput={(event) => {
              const target = event.target as HTMLTextAreaElement;
              target.style.height = "auto";
              target.style.height = `${Math.min(target.scrollHeight, 180)}px`;
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
                  <img className={styles.imagePreview} src={image.dataUrl} alt={`Pasted prompt preview ${imageIndex + 1}`} />
                  <button type="button" className={styles.removeImageButton} onClick={() => setPastedImages((current) => current.filter((_, index) => index !== imageIndex))} aria-label={`Remove pasted image ${imageIndex + 1}`}>
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          <button type="submit" className={styles.submitButton} disabled={isLoading || (!input.trim() && !pastedImages.length)}>
            {isLoading ? "Thinking…" : "Send"}
          </button>
        </form>
      </section>
    </main>
  );
}
