import * as fs from 'fs';
import * as path from 'path';
import { getToken } from './auth.service';
import { calculateSha256FromFile, sha256HexToBase64 } from './hash.service';
import { createEvidence, getEvidence } from './evidence.service';
import { uploadFileToS3 } from './s3-upload.service';
import { config } from './config';

export interface GenerateEvidenceInput {
  filePath: string;
  evidenceId: string;
  title: string;
  createdBy: string;
  capturedAt: string;
  custodyType?: string;
  testimony?: Record<string, { required: boolean; providers: string[] }>;
  requiredTestimonyProviders?: string[];
  metadata?: Record<string, string>;
}

export interface GenerateEvidenceResult {
  evidenceId: string;
  status: string;
  details: Record<string, unknown>;
}

export async function* generateEvidence(input: GenerateEvidenceInput): AsyncGenerator<string, GenerateEvidenceResult> {
  // Validate file exists
  if (!fs.existsSync(input.filePath)) {
    throw new Error(`File not found: ${input.filePath}`);
  }

  const stats = fs.statSync(input.filePath);
  const fileName = path.basename(input.filePath);

  yield 'Authenticating with Okta...';
  const token = await getToken();

  yield `Calculating SHA-256 of ${fileName}...`;
  const hashHex = calculateSha256FromFile(input.filePath);
  const hashBase64 = sha256HexToBase64(hashHex);

  yield 'Creating evidence record...';
  const { url: presignedUrl } = await createEvidence(token, {
    evidenceId: input.evidenceId,
    hash: hashHex,
    capturedAt: input.capturedAt,
    custodyType: input.custodyType ?? 'INTERNAL',
    title: input.title,
    fileName,
    createdBy: input.createdBy,
    fileSize: stats.size,
    testimony: input.testimony,
    requiredTestimonyProviders: input.requiredTestimonyProviders,
    metadata: input.metadata,
  });

  yield `Uploading ${fileName} (${formatFileSize(stats.size)}) to S3...`;
  await uploadFileToS3(presignedUrl, input.filePath, hashBase64);

  yield 'Polling evidence status...';
  const finalStatus = await pollUntilCompleted(token, input.evidenceId);

  return {
    evidenceId: input.evidenceId,
    status: (finalStatus as Record<string, Record<string, string>>).status?.status ?? 'UNKNOWN',
    details: finalStatus,
  };
}

async function pollUntilCompleted(token: string, evidenceId: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < config.pollMaxAttempts; attempt++) {
    const evidence = await getEvidence(token, evidenceId);
    const status = (evidence as Record<string, Record<string, string>>).status?.status;

    if (status === 'COMPLETED' || status === 'ERROR') {
      return evidence;
    }

    await sleep(config.pollIntervalMs);
  }

  throw new Error(
    `Evidence ${evidenceId} did not reach a final state after ${config.pollMaxAttempts} polling attempts ` +
      `(${(config.pollMaxAttempts * config.pollIntervalMs) / 1000}s). It may still be processing — ` +
      `use get_evidence to check its current status.`,
  );
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
