import type { PolicyTier } from "@opencode/schema/abucode"

export function normalizePolicyTier(raw: string | undefined): PolicyTier {
  const clean = (raw ?? "").trim().toLowerCase()
  if (clean === "request_review" || clean === "review") return "request_review"
  if (clean === "auto") return "auto"
  if (clean === "turbo") return "turbo"
  return "default"
}
