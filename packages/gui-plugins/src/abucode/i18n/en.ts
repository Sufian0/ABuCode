const dict = {
  personaTitle: "Household Persona",
  noCharacter: "No Character (Vanilla)",
  defaultCortana: "Default (Cortana)",
  randomCharacter: "Random",
  filterPlaceholder: "Filter 343 characters or type Multi (e.g. Cortana, Juliet)...",
  wildcardPlaceholder: "Optional custom description for Other 1..10...",
  applyChat: "Apply",
  saveGlobal: "Save Default",
  memoryTitle: "Pinned Session Memory",
  memoryEmpty: "Memory",
  memoryActive: "Memory (Pinned)",
  memoryPlaceholder: "Pinned instructions, repo notes, or context injected into every turn of this session...",
  saveMemory: "Save Memory",
  clearMemory: "Clear",
  policyTitle: "Command Approval Policy",
  policyReview: "Request Review — Ask before every shell & git command",
  policyDefault: "Default — Ask before deletes, git push, installs & servers",
  policyAuto: "Auto — Run routine dev commands; ask before deletes, push, sudo & secrets",
  policyTurbo: "Turbo — Run commands automatically (disk wipe & fork bombs stay blocked)",
  requestFailed: "ABuCode update failed",
} as const

export default dict
