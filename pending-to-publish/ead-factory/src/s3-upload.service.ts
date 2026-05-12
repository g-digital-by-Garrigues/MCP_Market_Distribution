import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

export async function uploadFileToS3(presignedUrl: string, filePath: string, hashBase64: string): Promise<void> {
  const buffer = fs.readFileSync(filePath);
  const contentType = resolveContentType(filePath);

  await withRetry(async () => {
    await axios.put(presignedUrl, buffer, {
      headers: {
        'Content-Type': contentType,
        'x-amz-checksum-sha256': hashBase64,
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });
  });
}

async function withRetry(fn: () => Promise<void>, retries = MAX_RETRIES, delayMs = BASE_DELAY_MS): Promise<void> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await fn();
      return;
    } catch (error) {
      if (attempt === retries) {
        throw error;
      }
      const backoff = delayMs * Math.pow(2, attempt - 1);
      await sleep(backoff);
    }
  }
}

const CONTENT_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  bmp: 'image/bmp',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  txt: 'text/plain',
  csv: 'text/csv',
  html: 'text/html',
  xml: 'application/xml',
  json: 'application/json',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip',
  mp4: 'video/mp4',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
};

function resolveContentType(filePath: string): string {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
