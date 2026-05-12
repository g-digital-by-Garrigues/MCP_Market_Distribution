import axios from 'axios';
import { config } from './config';

export interface CloseConfig {
  condition?: 'ALL_REQUIRED' | 'PARTIAL_ALLOWED';
  date?: string;
}

export interface SignatureRequestBodyModel {
  status?: 'DRAFT' | 'ACTIVE' | 'REJECTED' | 'COMPLETED' | 'CANCELLED';
  content?: {
    body?: string;
    subject?: string;
    additionalText?: string;
  };
}

export interface CreateSignatureRequestInput {
  name: string;
  createdBy: string;
  description?: string;
  notifications?: boolean;
  language?: string;
  uniqueValidator?: boolean;
  provider?: 'NOTICEMAN' | 'NOTICEMAN_AND_WHATSAPP';
  senderName?: string;
  senderAddress?: string;
  closeConfig?: CloseConfig;
  signatureRequestBody?: SignatureRequestBodyModel[];
}

export interface SignatureRequestViewModel {
  id: string;
  name: string;
  description?: string;
  createdBy: string;
  status: string;
  notifications?: boolean;
  language?: string;
  uniqueValidator?: boolean;
  provider?: string;
  senderName?: string;
  senderAddress?: string;
  cancellationReason?: string;
  signatureRequestBody?: unknown[];
}

export interface SignatureRequestDetailViewModel {
  id: string;
  status: string;
  name: string;
  description?: string;
  cancellationReason?: unknown;
  createdBy: string;
  senderName?: string;
  senderAddress?: string;
  notifications?: boolean;
  documents?: unknown[];
  createdAt?: string;
  language?: string;
  statusHistory?: unknown[];
  signatureRequestBody?: unknown[];
  uniqueValidator?: boolean;
  provider?: string;
  closeConfig?: CloseConfig;
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

export async function createSignatureRequest(
  token: string,
  input: CreateSignatureRequestInput,
): Promise<SignatureRequestViewModel> {
  const body: Record<string, unknown> = {
    name: input.name,
    createdBy: input.createdBy,
  };

  if (input.description !== undefined) body.description = input.description;
  if (input.notifications !== undefined) body.notifications = input.notifications;
  if (input.language !== undefined) body.language = input.language;
  if (input.uniqueValidator !== undefined) body.uniqueValidator = input.uniqueValidator;
  if (input.provider !== undefined) body.provider = input.provider;
  if (input.senderName !== undefined) body.senderName = input.senderName;
  if (input.senderAddress !== undefined) body.senderAddress = input.senderAddress;
  if (input.closeConfig !== undefined) body.closeConfig = input.closeConfig;
  if (input.signatureRequestBody !== undefined) body.signatureRequestBody = input.signatureRequestBody;

  const response = await axios.post(
    `${config.signatureApiBaseUrl}/api/v1/private/signature-requests`,
    body,
    { headers: buildHeaders(token) },
  );

  return response.data;
}

export interface CertificateFilesRequestModel {
  originalDocument?: boolean;
  signedDocument?: boolean;
}

export interface AddDocumentInput {
  filename: string;
  title: string;
  hash: string;
  signatureType: 'INTERPOSITION' | 'ADVANCED' | 'OTHER';
  description?: string;
  signatureDeadline?: string;
  provider?: 'EADTRUST';
  evidenceId?: string;
  metadata?: Record<string, string>;
  certificateFiles?: CertificateFilesRequestModel;
  sequence?: number;
  fileSize?: number;
  detached?: boolean;
  convertToPdf?: boolean;
}

export interface AddDocumentViewModel {
  id: string;
  url: string;
  expiration?: string;
}

export interface SignatoryCoordinates {
  x: number;
  y: number;
  page: number;
}

export interface AddSignatoryInput {
  name: string;
  email: string;
  surnames?: string;
  phone?: string;
  coordinates?: SignatoryCoordinates[];
  sequence?: number;
  uniqueValidator?: boolean;
}

export interface SignatoryViewModel {
  id: string;
  name: string;
  surnames?: string;
  email: string;
  documentId?: string;
  phone?: string;
  signatureStatus?: string;
  coordinates?: unknown[];
  registeredAt?: string;
  sequence?: number;
  uniqueValidator?: boolean;
  validators?: unknown[];
  notifications?: unknown[];
}

export async function addSignatoryToDocument(
  token: string,
  signatureRequestId: string,
  documentId: string,
  input: AddSignatoryInput,
): Promise<SignatoryViewModel> {
  const body: Record<string, unknown> = {
    name: input.name,
    email: input.email,
  };

  if (input.surnames !== undefined) body.surnames = input.surnames;
  if (input.phone !== undefined) body.phone = input.phone;
  if (input.coordinates !== undefined) body.coordinates = input.coordinates;
  if (input.sequence !== undefined) body.sequence = input.sequence;
  if (input.uniqueValidator !== undefined) body.uniqueValidator = input.uniqueValidator;

  const response = await axios.post(
    `${config.signatureApiBaseUrl}/api/v1/private/signature-requests/${signatureRequestId}/documents/${documentId}/signatories`,
    body,
    { headers: buildHeaders(token) },
  );

  return response.data;
}

export async function addDocumentToSignatureRequest(
  token: string,
  signatureRequestId: string,
  input: AddDocumentInput,
): Promise<AddDocumentViewModel> {
  const body: Record<string, unknown> = {
    filename: input.filename,
    title: input.title,
    hash: input.hash,
    signatureType: input.signatureType,
  };

  if (input.description !== undefined) body.description = input.description;
  if (input.signatureDeadline !== undefined) body.signatureDeadline = input.signatureDeadline;
  if (input.provider !== undefined) body.provider = input.provider;
  if (input.evidenceId !== undefined) body.evidenceId = input.evidenceId;
  if (input.metadata !== undefined) body.metadata = input.metadata;
  if (input.certificateFiles !== undefined) body.certificateFiles = input.certificateFiles;
  if (input.sequence !== undefined) body.sequence = input.sequence;
  if (input.fileSize !== undefined) body.fileSize = input.fileSize;
  if (input.detached !== undefined) body.detached = input.detached;
  if (input.convertToPdf !== undefined) body.convertToPdf = input.convertToPdf;

  const response = await axios.post(
    `${config.signatureApiBaseUrl}/api/v1/private/signature-requests/${signatureRequestId}/documents`,
    body,
    { headers: buildHeaders(token) },
  );

  return response.data;
}

export interface AddValidatorInput {
  name: string;
  email: string;
  surnames?: string;
  phone?: string;
}

export interface ValidatorViewModel {
  id: string;
  name: string;
  surnames?: string;
  phone?: string;
  email: string;
  documentId?: string;
  signatoryId?: string;
}

export interface AddObserverInput {
  name: string;
  email: string;
  surnames?: string;
}

export interface ObserverViewModel {
  id: string;
  name: string;
  surnames?: string;
  email: string;
  notifications?: unknown[];
}

export async function addObserverToDocument(
  token: string,
  signatureRequestId: string,
  documentId: string,
  input: AddObserverInput,
): Promise<ObserverViewModel> {
  const body: Record<string, unknown> = {
    name: input.name,
    email: input.email,
  };

  if (input.surnames !== undefined) body.surnames = input.surnames;

  const response = await axios.post(
    `${config.signatureApiBaseUrl}/api/v1/private/signature-requests/${signatureRequestId}/documents/${documentId}/observers`,
    body,
    { headers: buildHeaders(token) },
  );

  return response.data;
}

export async function addValidatorToSignatory(
  token: string,
  documentId: string,
  signatoryId: string,
  input: AddValidatorInput,
): Promise<ValidatorViewModel> {
  const body: Record<string, unknown> = {
    name: input.name,
    email: input.email,
  };

  if (input.surnames !== undefined) body.surnames = input.surnames;
  if (input.phone !== undefined) body.phone = input.phone;

  const response = await axios.post(
    `${config.signatureApiBaseUrl}/api/v1/private/documents/${documentId}/signatories/${signatoryId}/validators`,
    body,
    { headers: buildHeaders(token) },
  );

  return response.data;
}

export async function activateSignatureRequest(
  token: string,
  signatureRequestId: string,
): Promise<{ id: string; status: string }> {
  const response = await axios.post(
    `${config.signatureApiBaseUrl}/api/v1/private/signature-requests/${signatureRequestId}/activate`,
    null,
    { headers: buildHeaders(token) },
  );

  return response.data;
}

export async function getSignatureRequest(
  token: string,
  signatureRequestId: string,
): Promise<SignatureRequestDetailViewModel> {
  const response = await axios.get(
    `${config.signatureApiBaseUrl}/api/v1/private/signature-requests/${signatureRequestId}`,
    { headers: buildHeaders(token) },
  );

  return response.data;
}