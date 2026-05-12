import * as crypto from 'crypto';
import * as fs from 'fs';

export function calculateSha256FromFile(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

export function sha256HexToBase64(hexHash: string): string {
  return Buffer.from(hexHash, 'hex').toString('base64');
}
