import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

/**
 * Manual dev seed for the client intake flow. Not wired into `prisma db seed`.
 *
 * Creates a placeholder IntakeProgram (3 steps, 5 questions) for AGENCY_ID and
 * makes it the agency's only active program. Every step uses EXPLAINER_S3_KEY
 * as its explainer video.
 *
 * Re-running creates version N+1, deactivates N, and bumps the agency's
 * ndaVersion. That resets the NDA gate for every client of the agency and
 * gives each client a new session on their first GET /intake. Earlier sessions
 * and their answers folders remain and are intentionally not cleaned up.
 *
 * DATABASE_URL is the shared RDS used by the deployed backend.
 *
 * Prints one shell-assignable line (PROGRAM_ID=... Q5_ID=...) to prefix the
 * scripts/verify-intake.sh command with.
 */

const STEP_SPECS: ReadonlyArray<{ title: string; prompts: string[] }> = [
  {
    title: 'About your brand',
    prompts: [
      'Tell us what your brand does in your own words.',
      'Describe what makes your brand different from others in your space.',
    ],
  },
  {
    title: 'Your audience',
    prompts: [
      'Describe the person you most want to reach with your content.',
      'Tell us where your audience spends their time online.',
    ],
  },
  {
    title: 'Your goals',
    prompts: ['Tell us what success looks like for you in the next 90 days.'],
  },
];

const EXPLAINER_DURATION_SEC = 30;
const MAX_ANSWER_DURATION_SEC = 120;

const PLACEHOLDER_NDA_TEXT = [
  'This is placeholder non-disclosure agreement text for development. The agency and the client agree to keep confidential any non-public information shared during onboarding and production.',
  'Confidential information includes recordings, strategy notes, unreleased content, and business details disclosed by either party. It does not include information that is already public or independently developed.',
  'These obligations continue after the engagement ends. Replace this text with the agency’s real agreement before any client sees it.',
].join('\n\n');

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value === '') {
    console.error(`Missing required env var: ${name}`);
    process.exit(2);
  }
  return value;
}

async function main(): Promise<void> {
  const agencyId = requireEnv('AGENCY_ID');
  const explainerS3Key = requireEnv('EXPLAINER_S3_KEY');
  const connectionString = requireEnv('DATABASE_URL');

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
    log: ['error', 'warn'],
  });

  try {
    const result = await prisma.$transaction(async (tx) => {
      const agency = await tx.agency.findUnique({ where: { id: agencyId } });
      if (agency === null) {
        throw new Error(`Agency not found: ${agencyId}`);
      }

      await tx.intakeProgram.updateMany({
        where: { agencyId, isActive: true },
        data: { isActive: false },
      });

      const { _max } = await tx.intakeProgram.aggregate({
        where: { agencyId },
        _max: { version: true },
      });
      const newVersion = (_max.version ?? 0) + 1;

      const program = await tx.intakeProgram.create({
        data: {
          agencyId,
          title: 'Client intake (placeholder)',
          version: newVersion,
          isActive: true,
          steps: {
            create: STEP_SPECS.map((step, stepIndex) => ({
              order: stepIndex + 1,
              title: step.title,
              explainerS3Key,
              explainerDurationSec: EXPLAINER_DURATION_SEC,
              questions: {
                create: step.prompts.map((prompt, questionIndex) => ({
                  order: questionIndex + 1,
                  prompt,
                  maxDurationSec: MAX_ANSWER_DURATION_SEC,
                })),
              },
            })),
          },
        },
        include: {
          steps: {
            orderBy: { order: 'asc' },
            include: { questions: { orderBy: { order: 'asc' } } },
          },
        },
      });

      const ndaVersion = `2026-10-v${newVersion}`;
      await tx.agency.update({
        where: { id: agencyId },
        data: {
          ndaVersion,
          ...(agency.ndaText === null ? { ndaText: PLACEHOLDER_NDA_TEXT } : {}),
        },
      });

      return { program, ndaVersion };
    });

    const { program, ndaVersion } = result;
    const stepIds = program.steps.map((s) => s.id);
    const questionIds = program.steps.flatMap((s) =>
      s.questions.map((q) => q.id),
    );
    if (stepIds.length !== 3 || questionIds.length !== 5) {
      throw new Error(
        `Unexpected layout: ${stepIds.length} steps, ${questionIds.length} questions`,
      );
    }

    console.error(
      `Seeded intake program v${program.version} for agency ${agencyId}`,
    );
    // One line so it can prefix the verify command directly.
    console.log(
      [
        `PROGRAM_ID=${program.id}`,
        `NDA_VERSION=${ndaVersion}`,
        ...stepIds.map((id, i) => `STEP${i + 1}_ID=${id}`),
        ...questionIds.map((id, i) => `Q${i + 1}_ID=${id}`),
      ].join(' '),
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
