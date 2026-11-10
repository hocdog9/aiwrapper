import { NextResponse } from "next/server";

function retired() {
  return NextResponse.json({ error: "Consensus now includes model access with Free and Premium. Refresh the app to continue." }, { status: 410 });
}

export const GET = retired;
export const PUT = retired;
export const DELETE = retired;
