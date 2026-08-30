export function resolveServerBase(
  rawValue = process.env.GPT_SWITCH_SERVER_BASE || "",
) {
  return String(rawValue || "").trim().replace(/\/+$/, "");
}
