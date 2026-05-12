import axios from 'axios';
import { config } from './config';

interface CreateEvidenceRequest {
  evidenceId: string;
  hash: string;
  capturedAt: string;
  custodyType: string;
  title: string;
  fileName: string;
  createdBy: string;
  fileSize?: number;
  testimony?: Record<string, { required: boolean; providers: string[] }>;
  requiredTestimonyProviders?: string[];
  metadata?: Record<string, string>;
}

interface CreateEvidenceResponse {
  url: string;
  expiration: string;
}

function buildHeaders(token: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };
  if (config.tenantId) {
    headers['X-Tenant-Id'] = config.tenantId;
  }
  return headers;
}

export async function createEvidence(token: string, request: CreateEvidenceRequest): Promise<CreateEvidenceResponse> {
  const body: Record<string, unknown> = {
    evidenceId: request.evidenceId,
    hash: request.hash,
    capturedAt: request.capturedAt,
    custodyType: request.custodyType,
    title: request.title,
    fileName: request.fileName,
    createdBy: request.createdBy,
    testimony: request.testimony ?? {
      TSP: { required: true, providers: ['EADTrust'] },
    },
  };

  if (request.fileSize !== undefined) body.fileSize = request.fileSize;
  if (request.requiredTestimonyProviders !== undefined) body.requiredTestimonyProviders = request.requiredTestimonyProviders;
  if (request.metadata !== undefined) body.metadata = request.metadata;

  const response = await axios.post(`${config.apiBaseUrl}/api/v1/private/evidences`, body, {
    headers: buildHeaders(token),
  });

  return response.data;
}

export async function getEvidence(token: string, evidenceId: string): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };
  if (config.tenantId) {
    headers['X-Tenant-Id'] = config.tenantId;
  }

  const response = await axios.get(`${config.apiBaseUrl}/api/v1/private/evidences/${evidenceId}`, {
    headers,
  });

  return response.data;
}
