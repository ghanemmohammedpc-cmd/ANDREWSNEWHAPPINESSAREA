import { z } from 'zod';
export const idSchema = z.string().uuid();
export const metadataSchema = z.object({
  name: z.string().trim().min(1).max(160),
  creator: z.string().trim().min(1).max(120),
  type: z.enum(['car', 'map', 'addon']),
  manufacturer: z.string().trim().max(80).default(''),
  model: z.string().trim().max(100).default(''),
  years: z.string().trim().max(40).default(''),
  description: z.string().trim().max(6000).default(''),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  compatibility: z.string().trim().max(100).default(''),
  permissionNotes: z.string().trim().max(2000).default(''),
  thumbnailId: idSchema.nullable().default(null),
  featured: z.boolean().default(false),
});
export const uploadSchema = z.object({
  modId: idSchema.optional(),
  metadata: metadataSchema,
  filename: z.string().min(1).max(220),
  size: z.number().int().positive().max(2 * 1024 ** 3),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  version: z.string().trim().max(60).default(''),
  changelog: z.string().trim().max(4000).default(''),
  publish: z.boolean().default(false),
  distributionConfirmed: z.literal(true),
});
export const querySchema = z.object({
  q: z.string().max(200).default(''), type: z.enum(['car', 'map', 'addon', 'all']).default('all'),
  tag: z.string().max(40).default(''), sort: z.enum(['newest', 'name', 'size', 'downloads']).default('newest'),
  page: z.coerce.number().int().min(1).max(100000).default(1), limit: z.coerce.number().int().min(1).max(60).default(24),
});
export type ModMetadata = z.infer<typeof metadataSchema>;
export type UploadInput = z.infer<typeof uploadSchema>;
export const discordIdSchema = z.string().regex(/^\d{15,22}$/);
export const sessionTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{40,100}$/);
export const versionSchema = z.object({
  id: idSchema, modId: idSchema, version: z.string().max(60), changelog: z.string().max(4000),
  filename: z.string().min(1).max(220).refine(value => { try { safeFilename(value); return true; } catch { return false; } }),
  size: z.number().int().positive().max(2 * 1024 ** 3), sha256: z.string().regex(/^[a-f0-9]{64}$/), createdAt: z.number().int().nonnegative(),
});
export const modSchema = metadataSchema.extend({
  id: idSchema, status: z.enum(['draft', 'published']), createdAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative(), downloads: z.number().int().nonnegative(), activeVersion: versionSchema.nullable(), rating: z.number().min(1).max(5).nullable().default(null), reviewCount: z.number().int().nonnegative().default(0),
}).refine(value => !value.activeVersion || value.activeVersion.modId === value.id);
export const userSchema = z.object({
  id: discordIdSchema, name: z.string().min(1).max(100), admin: z.boolean(), mode: z.literal('discord'), verifiedAt: z.number().int().nonnegative(),
  avatar: z.string().url().refine(value => { const url = new URL(value); return url.protocol === 'https:' && url.hostname === 'cdn.discordapp.com' && !url.username && !url.password && !url.port; }).nullable(),
});
export type Mod = z.infer<typeof modSchema>;
export type ModVersion = z.infer<typeof versionSchema>;
export type User = z.infer<typeof userSchema>;
export type ReviewList = { average: number | null; count: number; items: Array<{ userId: string; name: string; rating: number; body: string; createdAt: number; updatedAt: number }> };
export type Settings = { serverUrl: string; modsFolder: string; language: 'ar' | 'en'; adminLanguage: 'ar' | 'en'; parallelDownloads: number };
export type Progress = { id: string; name: string; kind: 'download' | 'upload'; stage: 'queued' | 'validating' | 'transferring' | 'storing' | 'installing' | 'completed' | 'cancelled' | 'failed'; bytes: number; total: number | null; speed: number; error?: string; modId?: string };
export class HubError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); this.name = 'HubError'; }
}
export function safeFilename(input: string): string {
  if (input !== input.normalize('NFC') || /[<>:"/\\|?*\x00-\x1f]/.test(input) || /[. ]$/.test(input) || /^\.+$/.test(input) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(input)) throw new HubError('INVALID_FILENAME', 'The ZIP filename is not supported.');
  if (!input.toLowerCase().endsWith('.zip') || input.length > 220) throw new HubError('INVALID_FILENAME', 'Select a ZIP file.');
  return input;
}
export function normalizedSearch(value: string): string { return value.normalize('NFKC').toLocaleLowerCase().replace(/[\u064b-\u065f\u0670\u0640]/g, '').replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي'); }
