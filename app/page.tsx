"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
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
};

type ChatSession = {
  id: string;
  title: string;
  chat: ChatTurn[];
  result: ResponsePayload | null;
};

type ProviderName = "GPT" | "Gemini" | "Claude";

type ProviderSettings = {
  enabled: boolean;
  apiKey: string;
  model: string;
};

type AppSettings = Record<ProviderName, ProviderSettings>;

type SettingsProfile = {
  id: string;
  name: string;
  settings: AppSettings;
};

const CHAT_HISTORY_KEY = "consensus-ai-chat-history";
const SETTINGS_KEY = "consensus-ai-settings";
const PROFILES_KEY = "consensus-ai-profiles";

const defaultSettings: AppSettings = {
  GPT: { enabled: true, apiKey: "", model: "gpt-4o-mini" },
  Gemini: { enabled: true, apiKey: "", model: "gemini-3.6-flash" },
  Claude: { enabled: false, apiKey: "", model: "claude-3-5-sonnet-20241022" },
};

const availableModels: Record<ProviderName, Array<{ id: string; efficiency?: "most" | "least" }>> = {
  GPT: [
    { id: "gpt-4o-mini", efficiency: "most" },
    { id: "gpt-4o" },
    { id: "gpt-4.1-mini" },
    { id: "gpt-4.1", efficiency: "least" },
  ],
  Gemini: [
    { id: "gemini-3.6-flash", efficiency: "most" },
    { id: "gemini-2.5-flash" },
    { id: "gemini-2.5-pro", efficiency: "least" },
  ],
  Claude: [
    { id: "claude-3-5-haiku-20241022", efficiency: "most" },
    { id: "claude-3-5-sonnet-20241022" },
    { id: "claude-3-opus-20240229", efficiency: "least" },
  ],
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

export default function Home() {
  const [input, setInput] = useState("");
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeChatId, setActiveChatId] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [statusText, setStatusText] = useState("Ready to compare model responses.");
  const [error, setError] = useState<string | null>(null);
  const [isDark, setIsDark] = useState(true);
  const [showClaims, setShowClaims] = useState(false);
  const [pastedImage, setPastedImage] = useState<ChatTurn["image"]>();
  const [settings, setSettings] = useState<AppSettings>(defaultSettings);
  const [profiles, setProfiles] = useState<SettingsProfile[]>([]);
  const [activeProfileId, setActiveProfileId] = useState("");
  const [profileName, setProfileName] = useState("Default");
  const [profilesLoaded, setProfilesLoaded] = useState(false);
  const [userEmail, setUserEmail] = useState("");
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authMode, setAuthMode] = useState<"login" | "signup">("login");
  const [authError, setAuthError] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const activeSession = sessions.find((session) => session.id === activeChatId) ?? sessions[0];
  const chat = activeSession?.chat ?? [];
  const result = activeSession?.result ?? null;

  useEffect(() => {
    const savedProfiles = window.localStorage.getItem(PROFILES_KEY);
    if (savedProfiles) {
      try {
        const parsed = JSON.parse(savedProfiles) as SettingsProfile[];
        if (parsed.length) {
          const profile = parsed[0];
          setProfiles(parsed);
          setActiveProfileId(profile.id);
          setProfileName(profile.name);
          setSettings(profile.settings);
          setProfilesLoaded(true);
          return;
        }
      } catch {
        window.localStorage.removeItem(PROFILES_KEY);
      }
    }
    const savedSettings = window.localStorage.getItem(SETTINGS_KEY);
    const migratedSettings = savedSettings ? { ...defaultSettings, ...JSON.parse(savedSettings) } : defaultSettings;
    const defaultProfile = createSettingsProfile("Default", migratedSettings);
    setProfiles([defaultProfile]);
    setActiveProfileId(defaultProfile.id);
    setProfileName(defaultProfile.name);
    setSettings(defaultProfile.settings);
    setProfilesLoaded(true);
  }, []);

  useEffect(() => {
    let active = true;
    async function loadAccount() {
      const { data } = await supabase.auth.getUser();
      if (!active || !data.user) return;
      setUserEmail(data.user.email ?? "");
      const { data: remoteProfiles } = await supabase.from("api_profiles").select("id, name, settings").order("created_at");
      if (remoteProfiles?.length) {
        const nextProfiles = remoteProfiles as SettingsProfile[];
        setProfiles(nextProfiles);
        setActiveProfileId(nextProfiles[0].id);
        setProfileName(nextProfiles[0].name);
        setSettings(nextProfiles[0].settings);
      }
    }
    loadAccount();
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session?.user) {
        setUserEmail(session.user.email ?? "");
        loadAccount();
      } else {
        setUserEmail("");
      }
    });
    return () => {
      active = false;
      listener.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!profilesLoaded) return;
    const updatedProfiles = profiles.map((profile) => profile.id === activeProfileId
      ? { ...profile, name: profileName, settings }
      : profile);
    if (JSON.stringify(updatedProfiles) !== JSON.stringify(profiles)) {
      setProfiles(updatedProfiles);
    }
    window.localStorage.setItem(PROFILES_KEY, JSON.stringify(updatedProfiles));
    if (userEmail && activeProfileId) {
      supabase.auth.getUser().then(({ data }) => {
        if (data.user) {
          supabase.from("api_profiles").upsert({
            id: activeProfileId,
            user_id: data.user.id,
            name: profileName,
            settings,
          }).then();
        }
      });
    }
  }, [settings, profileName, activeProfileId, profilesLoaded, profiles, userEmail]);

  useEffect(() => {
    const savedHistory = window.localStorage.getItem(CHAT_HISTORY_KEY);
    if (savedHistory) {
      try {
        const parsed = JSON.parse(savedHistory) as ChatSession[];
        if (parsed.length) {
          setSessions(parsed);
          setActiveChatId(parsed[0].id);
          return;
        }
      } catch {
        window.localStorage.removeItem(CHAT_HISTORY_KEY);
      }
    }
    const firstSession = createChatSession();
    setSessions([firstSession]);
    setActiveChatId(firstSession.id);
  }, []);

  useEffect(() => {
    if (sessions.length) {
      window.localStorage.setItem(CHAT_HISTORY_KEY, JSON.stringify(sessions));
    }
  }, [sessions]);

  useEffect(() => {
    const storedTheme = window.localStorage.getItem(THEME_KEY);
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const nextTheme = storedTheme ? storedTheme === "dark" : prefersDark;
    setIsDark(nextTheme);
  }, []);

  useEffect(() => {
    window.localStorage.setItem(THEME_KEY, isDark ? "dark" : "light");
  }, [isDark]);

  useEffect(() => {
    if (viewportRef.current) {
      viewportRef.current.scrollTop = viewportRef.current.scrollHeight;
    }
  }, [chat, result, isLoading]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = input.trim();
    if ((!trimmed && !pastedImage) || isLoading) return;

    const userTurn: ChatTurn = { role: "user", content: trimmed, image: pastedImage };
    const requestMessages = [...chat, userTurn];

    setSessions((current) => current.map((session) => session.id === activeSession?.id
      ? { ...session, chat: [...session.chat, userTurn], title: session.title === "New chat" ? trimmed.slice(0, 42) : session.title }
      : session));
    setInput("");
    setPastedImage(undefined);
    setError(null);
    setIsLoading(true);
    setStatusText("Asking GPT…");

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: requestMessages, settings }),
      });

      const payload = (await response.json()) as ResponsePayload & { error?: string };

      if (!response.ok) {
        throw new Error(payload.error ?? "Unable to fetch consensus.");
      }

      setStatusText("Consensus ready.");
      setSessions((current) => current.map((session) => {
        if (session.id !== activeSession?.id) return session;
        const currentChat = session.chat;
        const chatWithUserTurn = currentChat.some(
          (message) => message.role === "user" && message.content === userTurn.content
        )
          ? currentChat
          : [...currentChat, userTurn];
        const assistantMessage = {
          role: "assistant" as const,
          content: payload.consensus || "Here is the synthesized consensus.",
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
  }

  function saveNewProfile() {
    const name = profileName.trim() || "New profile";
    const profile = createSettingsProfile(name, settings);
    setProfiles((current) => [...current, profile]);
    setActiveProfileId(profile.id);
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
      supabase.from("api_profiles").delete().eq("id", activeProfileId).then();
    }
  }

  async function handleAuth(event: FormEvent) {
    event.preventDefault();
    setAuthError("");
    const result = authMode === "login"
      ? await supabase.auth.signInWithPassword({ email: authEmail, password: authPassword })
      : await supabase.auth.signUp({ email: authEmail, password: authPassword });
    if (result.error) setAuthError(result.error.message);
    else {
      setAuthEmail("");
      setAuthPassword("");
    }
  }

  async function signOut() {
    await supabase.auth.signOut();
    setUserEmail("");
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
    setInput("");
    setPastedImage(undefined);
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
        {showSettings && (
          <div className={styles.settingsPanel}>
            <div className={styles.historyHeader}>
              <p className={styles.mutedLabel}>Model settings</p>
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
              onChange={(event) => setProfileName(event.target.value)}
              placeholder="Profile name"
              aria-label="Profile name"
            />
            <div className={styles.profileActions}>
              <button type="button" className={styles.profileButton} onClick={saveNewProfile}>Save as new</button>
              <button type="button" className={styles.profileButton} onClick={deleteProfile} disabled={profiles.length <= 1}>Delete profile</button>
            </div>
            <p className={styles.settingsNote}>{userEmail ? "Signed-in profiles sync across browsers." : "Keys are stored locally until you sign in."}</p>
            {userEmail ? (
              <div className={styles.accountRow}>
                <span>{userEmail}</span>
                <button type="button" className={styles.profileButton} onClick={signOut}>Sign out</button>
              </div>
            ) : (
              <form className={styles.authForm} onSubmit={handleAuth}>
                <p className={styles.settingsNote}>Sign in to use these profiles on other browsers.</p>
                <input className={styles.settingsInput} type="email" value={authEmail} onChange={(event) => setAuthEmail(event.target.value)} placeholder="Email" required />
                <input className={styles.settingsInput} type="password" value={authPassword} onChange={(event) => setAuthPassword(event.target.value)} placeholder="Password" minLength={6} required />
                {authError && <p className={styles.authError}>{authError}</p>}
                <button type="submit" className={styles.profileButton}>{authMode === "login" ? "Sign in" : "Create account"}</button>
                <button type="button" className={styles.authSwitch} onClick={() => setAuthMode((current) => current === "login" ? "signup" : "login")}>
                  {authMode === "login" ? "Create an account" : "Already have an account? Sign in"}
                </button>
              </form>
            )}
            {(["GPT", "Gemini", "Claude"] as ProviderName[]).map((provider) => (
              <div key={provider} className={styles.providerSetting}>
                <label className={styles.providerCheck}>
                  <input
                    type="checkbox"
                    checked={settings[provider].enabled}
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
                  {availableModels[provider].map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.id}{model.efficiency === "most" ? " - Most efficient" : model.efficiency === "least" ? " - Least efficient" : ""}
                    </option>
                  ))}
                </select>
                <input
                  className={styles.settingsInput}
                  type="password"
                  value={settings[provider].apiKey}
                  onChange={(event) => setSettings((current) => ({
                    ...current,
                    [provider]: { ...current[provider], apiKey: event.target.value },
                  }))}
                  placeholder="API key (optional if in .env.local)"
                  aria-label={`${provider} API key`}
                />
              </div>
            ))}
          </div>
        )}
        <div className={styles.sidebarCard}>
          <p className={styles.mutedLabel}>Current status</p>
          <p className={styles.statusLine}>{statusText}</p>
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

      <section className={styles.chatArea}>
        <div className={styles.chatViewport} ref={viewportRef}>
          {chat.length === 0 && !result && (
            <div className={styles.emptyState}>
              <h2>Ask a question and compare three model opinions.</h2>
              <p>Each prompt is evaluated by GPT, Gemini, and Claude, then synthesized into one transparent answer.</p>
            </div>
          )}

          {chat.map((message, index) => (
            <div key={`${message.role}-${index}`} className={`${styles.messageRow} ${message.role === "user" ? styles.userRow : styles.assistantRow}`}>
              <div className={styles.messageBubble}>
                <span className={styles.messageRole}>{message.role === "user" ? "You" : "Consensus"}</span>
                {message.image && <img className={styles.messageImage} src={message.image.dataUrl} alt="Pasted prompt image" />}
                <div className={styles.messageContent}><ReactMarkdown>{message.content}</ReactMarkdown></div>
              </div>
            </div>
          ))}

          {isLoading && (
            <div className={styles.loadingRow}>
              <div className={styles.loadingBubble}>
                <span className={styles.messageRole}>Working</span>
                <div className={styles.loader}>Asking GPT, Gemini, and Claude…</div>
              </div>
            </div>
          )}

          {error && <div className={styles.errorCard}>{error}</div>}

          {result && (
            <article className={styles.resultPanel}>
              <div className={styles.resultHeader}>
                <div>
                  <p className={styles.mutedLabel}>Consensus</p>
                  <h3>{result.agreementScore !== null ? `${result.agreementScore}% model agreement` : "Low agreement"}</h3>
                </div>
                <span className={styles.agreementPill}>{result.summary}</span>
              </div>

              <div className={styles.resultBody}><ReactMarkdown>{result.consensus}</ReactMarkdown></div>

              <div className={styles.metaGrid}>
                <div className={styles.metaCard}>
                  <h4>Where they agree</h4>
                  <ul>
                    {result.agreements.length ? result.agreements.map((item) => <li key={item}>✓ {item}</li>) : <li>Not enough shared evidence.</li>}
                  </ul>
                </div>
                <div className={styles.metaCard}>
                  <h4>Where they differ</h4>
                  <ul>
                    {result.disagreements.length ? result.disagreements.map((item) => <li key={item}>! {item}</li>) : <li>No material disagreements surfaced.</li>}
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
                    <div className={styles.providerContent}><ReactMarkdown>{response.content}</ReactMarkdown></div>
                  </details>
                ))}
              </div>
            </article>
          )}
        </div>

        <form className={styles.composer} onSubmit={handleSubmit}>
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            rows={1}
            className={styles.textarea}
            placeholder="Ask for a comparison, a risk analysis, or a policy trade-off…"
            onPaste={(event) => {
              const imageItem = Array.from(event.clipboardData.items).find((item) => item.type.startsWith("image/"));
              if (!imageItem) return;

              const file = imageItem.getAsFile();
              if (!file) return;

              event.preventDefault();
              const reader = new FileReader();
              reader.onload = () => {
                if (typeof reader.result === "string") {
                  setPastedImage({ dataUrl: reader.result, mimeType: file.type });
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
          {pastedImage && (
            <div className={styles.imagePreviewWrap}>
              <img className={styles.imagePreview} src={pastedImage.dataUrl} alt="Pasted prompt preview" />
              <button type="button" className={styles.removeImageButton} onClick={() => setPastedImage(undefined)} aria-label="Remove pasted image">
                ×
              </button>
            </div>
          )}
          <button type="submit" className={styles.submitButton} disabled={isLoading || (!input.trim() && !pastedImage)}>
            {isLoading ? "Thinking…" : "Send"}
          </button>
        </form>
      </section>
    </main>
  );
}
