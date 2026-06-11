import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const baseHeaders = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Vary': 'Origin'
};

const rateBuckets = new Map();

function allowedOrigins() {
    return String(process.env.ALLOWED_ORIGINS || '')
        .split(',')
        .map(origin => origin.trim())
        .filter(Boolean);
}

function isAllowedOrigin(origin) {
    if (!origin) return true;
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) return true;
    return allowedOrigins().includes(origin);
}

function corsHeaders(request) {
    const origin = request?.headers?.get('origin') || '';
    return {
        ...baseHeaders,
        'Access-Control-Allow-Origin': !request ? '*' : (origin && isAllowedOrigin(origin) ? origin : 'null')
    };
}

function checkRateLimit(request) {
    const now = Date.now();
    const windowMs = 60_000;
    const limit = Number(process.env.APPEALS_RATE_LIMIT_PER_MINUTE || 30);
    const forwarded = request.headers.get('x-forwarded-for') || '';
    const ip = forwarded.split(',')[0].trim()
        || request.headers.get('x-nf-client-connection-ip')
        || request.headers.get('client-ip')
        || 'unknown';
    const bucket = `${ip}:${Math.floor(now / windowMs)}`;
    const count = (rateBuckets.get(bucket) || 0) + 1;
    rateBuckets.set(bucket, count);
    if (rateBuckets.size > 1000) {
        const currentWindow = String(Math.floor(now / windowMs));
        for (const key of rateBuckets.keys()) {
            if (!key.endsWith(currentWindow)) rateBuckets.delete(key);
        }
    }
    return count <= limit;
}

const localStorePath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'data',
    'ban-appeals.json'
);

let blobStorePromise = null;

function json(status, data, request) {
    return new Response(JSON.stringify(data), { status, headers: corsHeaders(request) });
}

async function getBlobStore() {
    if (blobStorePromise) return blobStorePromise;
    blobStorePromise = (async () => {
        if (!process.env.NETLIFY && !process.env.NETLIFY_BLOBS_CONTEXT && !process.env.NETLIFY_BLOBS_TOKEN) {
            return null;
        }
        try {
            const { getStore } = await import('@netlify/blobs');
            return getStore('veva-ban-appeals');
        } catch {
            return null;
        }
    })();
    return blobStorePromise;
}

async function readAppeals() {
    const store = await getBlobStore();
    if (store) {
        try {
            const raw = await store.get('appeals.json');
            return raw ? JSON.parse(raw) : [];
        } catch {
            return [];
        }
    }

    try {
        return JSON.parse(await fs.readFile(localStorePath, 'utf8'));
    } catch {
        return [];
    }
}

async function writeAppeals(appeals) {
    const store = await getBlobStore();
    if (store) {
        await store.set('appeals.json', JSON.stringify(appeals, null, 2), {
            metadata: { updatedAt: new Date().toISOString() }
        });
        return;
    }

    await fs.mkdir(path.dirname(localStorePath), { recursive: true });
    await fs.writeFile(localStorePath, JSON.stringify(appeals, null, 2), 'utf8');
}

async function readJson(request) {
    try {
        return await request.json();
    } catch {
        return {};
    }
}

function publicAppeal(appeal) {
    if (!appeal) return null;
    return {
        id: appeal.id,
        deviceId: appeal.deviceId,
        status: appeal.status,
        reason: appeal.reason,
        lastBadText: appeal.lastBadText,
        permanent: appeal.permanent,
        bannedUntil: appeal.bannedUntil,
        strikes: appeal.strikes,
        banAttempts: appeal.banAttempts,
        warningUntil: appeal.warningUntil,
        kind: appeal.kind,
        adminMessage: appeal.adminMessage,
        createdAt: appeal.createdAt,
        decidedAt: appeal.decidedAt
    };
}

export default async function handler(request) {
    if (request.method === 'OPTIONS') return new Response('', { status: 204, headers: corsHeaders(request) });
    if (!isAllowedOrigin(request.headers.get('origin') || '')) {
        return json(403, { ok: false, error: 'Forbidden origin' }, request);
    }
    if (request.method === 'POST' && !checkRateLimit(request)) {
        return json(429, { ok: false, error: 'Too many requests' }, request);
    }

    const url = new URL(request.url);
    const action = url.searchParams.get('action');
    const appeals = await readAppeals();

    if (request.method === 'GET') {
        if (action === 'status') {
            const id = url.searchParams.get('id') || '';
            const deviceId = url.searchParams.get('deviceId') || '';
            const appeal = appeals.find((item) => item.id === id && (!deviceId || item.deviceId === deviceId));
            return json(appeal ? 200 : 404, { ok: Boolean(appeal), appeal: publicAppeal(appeal) });
        }

        const sorted = appeals
            .slice()
            .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
            .map(publicAppeal);
        return json(200, { ok: true, appeals: sorted });
    }

    if (request.method !== 'POST') return json(405, { ok: false, error: 'Method not allowed' });

    const body = await readJson(request);
    if (body.action === 'create') {
        const id = String(body.id || `appeal-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`);
        const existingIndex = appeals.findIndex((item) => item.id === id);
        const appeal = {
            id,
            deviceId: String(body.deviceId || ''),
            status: 'pending',
            reason: String(body.reason || 'Unknown security trigger'),
            lastBadText: String(body.lastBadText || '').slice(0, 2000),
            permanent: body.permanent === true,
            bannedUntil: Number(body.bannedUntil || 0),
            strikes: Number(body.strikes || 0),
            banAttempts: Number(body.banAttempts || 0),
            userAgent: String(body.userAgent || ''),
            adminMessage: '',
            createdAt: new Date().toISOString(),
            decidedAt: ''
        };
        if (existingIndex >= 0) {
            appeals[existingIndex] = { ...appeals[existingIndex], ...appeal, createdAt: appeals[existingIndex].createdAt || appeal.createdAt };
        } else {
            appeals.push(appeal);
        }
        await writeAppeals(appeals);
        return json(200, { ok: true, appeal: publicAppeal(appeal) });
    }

    if (body.action === 'incident') {
        const appeal = {
            id: `incident-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
            deviceId: String(body.deviceId || ''),
            status: 'security-incident',
            kind: String(body.kind || 'security'),
            reason: String(body.reason || 'Unknown security trigger'),
            lastBadText: String(body.lastBadText || '').slice(0, 2000),
            permanent: body.permanent === true,
            bannedUntil: Number(body.bannedUntil || 0),
            strikes: Number(body.strikes || 0),
            banAttempts: Number(body.banAttempts || 0),
            warningUntil: Number(body.warningUntil || 0),
            userAgent: String(body.userAgent || ''),
            adminMessage: '',
            createdAt: new Date().toISOString(),
            decidedAt: ''
        };
        appeals.push(appeal);
        await writeAppeals(appeals);
        return json(200, { ok: true, appeal: publicAppeal(appeal) });
    }

    if (body.action === 'decide') {
        // Admin-only action: require a secret token
        const adminToken = process.env.APPEALS_ADMIN_TOKEN;
        const providedToken = String(body.adminToken || '');
        if (adminToken && (!providedToken || providedToken !== adminToken)) {
            return json(403, { ok: false, error: 'Forbidden: invalid admin token' }, request);
        }
        const id = String(body.id || '');
        const status = body.decision === 'approved' ? 'approved' : body.decision === 'rejected' ? 'rejected' : '';
        if (!id || !status) return json(400, { ok: false, error: 'Missing id or decision' });
        const appeal = appeals.find((item) => item.id === id);
        if (!appeal) return json(404, { ok: false, error: 'Appeal not found' });
        appeal.status = status;
        appeal.adminMessage = String(body.adminMessage || (status === 'approved' ? 'Апелляция одобрена. Аккаунт разблокирован.' : 'Апелляция отклонена.'));
        appeal.decidedAt = new Date().toISOString();
        await writeAppeals(appeals);
        return json(200, { ok: true, appeal: publicAppeal(appeal) });
    }

    return json(400, { ok: false, error: 'Unknown action' });
}
