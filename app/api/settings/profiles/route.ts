import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest } from "@/lib/server/auth";
import type { ProviderName } from "@/lib/server/model-pricing";

const PROVIDERS: ProviderName[] = ["GPT", "Gemini", "Claude"];

function sanitizeProfileSettings(value: unknown) {
  const settings = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const safe: Record<string, unknown> = {
    consensusDropdownDefaultOpen: settings.consensusDropdownDefaultOpen === true,
  };
  for (const provider of PROVIDERS) {
    const rawProviderSettings = settings[provider];
    const providerSettings = rawProviderSettings && typeof rawProviderSettings === "object"
      ? rawProviderSettings as Record<string, unknown>
      : {};
    safe[provider] = {
      enabled: providerSettings.enabled !== false,
      model: typeof providerSettings.model === "string" ? providerSettings.model.slice(0, 160) : "",
    };
  }
  return safe;
}

function uniqueNames<T extends { id: string; name: string }>(profiles: T[]): T[] {
  const seen = new Set<string>();
  return profiles.map((profile) => {
    const base = profile.name.trim() || "Profile";
    let name = base;
    let suffix = 2;
    while (seen.has(name.toLocaleLowerCase())) {
      name = `${base} (${suffix++})`;
    }
    seen.add(name.toLocaleLowerCase());
    return { ...profile, name };
  });
}

export async function GET(request: NextRequest) {
  const context = await authenticateRequest(request);
  if (!context) return NextResponse.json({ error: "AUTH_REQUIRED" }, { status: 401 });
  const { data, error } = await context.userClient.from("api_profiles")
    .select("id, name, settings").order("created_at", { ascending: true });
  if (error) return NextResponse.json({ error: "Could not load profiles. Apply the profile database migration." }, { status: 500 });
  const profiles = (data ?? []).map((profile) => ({
    ...profile,
    settings: sanitizeProfileSettings(profile.settings),
  }));
  return NextResponse.json({ profiles: uniqueNames(profiles) });
}

export async function PUT(request: NextRequest) {
  const context = await authenticateRequest(request);
  if (!context) return NextResponse.json({ error: "AUTH_REQUIRED" }, { status: 401 });
  const body = await request.json().catch(() => ({}));
  const id = typeof body.id === "string" ? body.id : "";
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 60) : "";
  if (!/^[0-9a-f-]{36}$/i.test(id) || !name) return NextResponse.json({ error: "A valid profile ID and name are required." }, { status: 400 });

  const { data: existing, error: lookupError } = await context.userClient.from("api_profiles")
    .select("id, name").eq("user_id", context.user.id);
  if (lookupError) return NextResponse.json({ error: "Could not validate profile name." }, { status: 500 });
  if ((existing ?? []).some((profile) => profile.id !== id && profile.name.trim().toLocaleLowerCase() === name.toLocaleLowerCase())) {
    return NextResponse.json({ error: "A profile with that name already exists." }, { status: 409 });
  }

  const { data, error } = await context.userClient.from("api_profiles").upsert({
    id,
    user_id: context.user.id,
    name,
    settings: sanitizeProfileSettings(body.settings),
  }).select("id, name, settings").single();
  if (error) return NextResponse.json({ error: "Could not save profile." }, { status: 500 });
  return NextResponse.json({ profile: { ...data, settings: sanitizeProfileSettings(data.settings) } });
}

export async function DELETE(request: NextRequest) {
  const context = await authenticateRequest(request);
  if (!context) return NextResponse.json({ error: "AUTH_REQUIRED" }, { status: 401 });
  const body = await request.json().catch(() => ({}));
  const id = typeof body.id === "string" ? body.id : "";
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "A valid profile ID is required." }, { status: 400 });
  const { error } = await context.userClient.from("api_profiles").delete().eq("id", id).eq("user_id", context.user.id);
  if (error) return NextResponse.json({ error: "Could not delete profile." }, { status: 500 });
  return NextResponse.json({ deleted: true });
}
