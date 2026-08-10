const WORKFLOW_ROLES = [
  "researcher",
  "test-author",
  "implementor",
  "reviewer",
  "verifier",
] as const;

const WORKFLOW_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

type WorkflowRole = (typeof WORKFLOW_ROLES)[number];
type WorkflowEffort = (typeof WORKFLOW_EFFORTS)[number];
interface WorkflowRolePolicy {
  model: string;
  reasoning: WorkflowEffort;
}

// The ONE role-policy table. WORKFLOW_ROLES above is only the canonical order
// used for serialization and cloning; model/effort values live only here.
const BASELINE_ROLE_POLICIES = {
  implementor: { model: "claude-sonnet-5", reasoning: "high" },
  researcher: { model: "claude-sonnet-5", reasoning: "medium" },
  reviewer: { model: "claude-opus-5", reasoning: "high" },
  "test-author": { model: "claude-opus-5", reasoning: "high" },
  verifier: { model: "claude-sonnet-5", reasoning: "medium" },
} as const satisfies Record<WorkflowRole, WorkflowRolePolicy>;

interface FingerprintMaterial {
  id: string;
  limits: {
    maxConcurrency: number;
    maxOuter: number;
  };
  roles: Record<WorkflowRole, WorkflowRolePolicy>;
  verification: string;
}

export interface WorkflowRecipe {
  capabilities: {
    effortPerWorkflowInvocation: true;
    modelPerWorkflowInvocation: true;
    sameRoleBuildThreadReuse: false;
  };
  fingerprint: `fnv1a32:${string}`;
  id: "baseline-v1";
  limits: {
    maxConcurrency: 2;
    maxOuter: 2;
  };
  roles: Record<WorkflowRole, { model: string; reasoning: WorkflowEffort }>;
  verification: "mechanical-first";
}

// The one Claude-native execution recipe. There are intentionally no profiles,
// project/global settings, environment variables, or CLI overrides: this fixed
// baseline is the experiment. Agent prompt bodies remain in plugin/agents; this
// module owns only model/effort plus the build-loop caps.
const BASELINE_FINGERPRINT_MATERIAL = {
  id: "baseline-v1",
  limits: { maxConcurrency: 2, maxOuter: 2 },
  roles: BASELINE_ROLE_POLICIES,
  verification: "mechanical-first",
} as const satisfies FingerprintMaterial;

export const WORKFLOW_RECIPE = {
  capabilities: {
    effortPerWorkflowInvocation: true,
    modelPerWorkflowInvocation: true,
    sameRoleBuildThreadReuse: false,
  },
  fingerprint: fingerprintRecipe(BASELINE_FINGERPRINT_MATERIAL),
  ...BASELINE_FINGERPRINT_MATERIAL,
} as const satisfies WorkflowRecipe;

export function resolveWorkflowRecipe(): WorkflowRecipe {
  return {
    capabilities: { ...WORKFLOW_RECIPE.capabilities },
    fingerprint: WORKFLOW_RECIPE.fingerprint,
    id: WORKFLOW_RECIPE.id,
    limits: { ...WORKFLOW_RECIPE.limits },
    roles: Object.fromEntries(
      WORKFLOW_ROLES.map((role) => [role, { ...WORKFLOW_RECIPE.roles[role] }])
    ) as WorkflowRecipe["roles"],
    verification: WORKFLOW_RECIPE.verification,
  };
}

// Stable fingerprint input, deliberately independent of object insertion order:
// id, five canonical roles, limits, then verification. The NUL separator makes
// adjacent fields unambiguous. FNV-1a is a drift detector, not a security hash.
function fingerprintRecipe(recipe: FingerprintMaterial): `fnv1a32:${string}` {
  const fields = [
    "dobby.workflow-recipe/v1",
    recipe.id,
    ...WORKFLOW_ROLES.flatMap((role) => [
      role,
      recipe.roles[role].model,
      recipe.roles[role].reasoning,
    ]),
    String(recipe.limits.maxOuter),
    String(recipe.limits.maxConcurrency),
    recipe.verification,
  ];
  const bytes = new TextEncoder().encode(fields.join("\0"));
  let hash = 0x81_1c_9d_c5;
  for (const byte of bytes) {
    // biome-ignore lint/suspicious/noBitwiseOperators: FNV-1a is defined as a byte XOR followed by unsigned 32-bit multiplication.
    hash = Math.imul(hash ^ byte, 0x01_00_01_93) >>> 0;
  }
  return `fnv1a32:${hash.toString(16).padStart(8, "0")}`;
}
