/**
 * Vercel Edge Function — ban appeals endpoint.
 * Ported from Netlify Functions (netlify/functions/ban-appeals.mjs).
 * Uses in-memory storage (ephemeral per cold-start).
 * For persistent storage, connect Supabase or another DB.
 */

export const config = { runtime: 'edge' };

/* ─── headers & CORS ─── */

const baseHeaders = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Vary': 'Origin'
};

const rateBuckets = new Map();
const appealsStore = [];          // in-memory; resets on cold start

function allowedOrigins() {
    return String(process.env.ALLOWED_ORIGINS || '')
        .split(',')
        .map(o => o.trim())
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

function json(status, data, request) {
    return new Response(JSON.stringify(data), { status, headers: corsHeaders(request) });
}

function checkRateLimit(request) {
    const now = Date.now();
    const windowMs = 60_000;
    const limit = Number(process.env.APPEALS_RATE_LIMIT_PER_MINUTE || 30);
    const forwarded = request.headers.get('x-forwarded-for') || '';
    const ip = forwarded.split(',')[0].trim()
        || request.headers.get('x-real-ip')
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

/* ─── helpers ─── */

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

async function readJson(request) {
    try { return await request.json(); } catch { return {}; }
}

/* ─── handler ─── */

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

    /* GET */
    if (request.method === 'GET') {
        if (action === 'status') {
            const id = url.searchParams.get('id') || '';
            const deviceId = url.searchParams.get('deviceId') || '';
            const appeal = appealsStore.find(item => item.id === id && (!deviceId || item.deviceId === deviceId));
            return json(appeal ? 200 : 404, { ok: Boolean(appeal), appeal: publicAppeal(appeal) });
        }
        const sorted = appealsStore
            .slice()
            .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
            .map(publicAppeal);
        return json(200, { ok: true, appeals: sorted });
    }

    if (request.method !== 'POST') return json(405, { ok: false, error: 'Method not allowed' });

    const body = await readJson(request);

    if (body.action === 'create') {
        const id = String(body.id || `appeal-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`);
        const existingIndex = appealsStore.findIndex(item => item.id === id);
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
            appealsStore[existingIndex] = { ...appealsStore[existingIndex], ...appeal, createdAt: appealsStore[existingIndex].createdAt || appeal.createdAt };
        } else {
            appealsStore.push(appeal);
        }
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
        appealsStore.push(appeal);
        return json(200, { ok: true, appeal: publicAppeal(appeal) });
    }

    if (body.action === 'decide') {
        const adminToken = process.env.APPEALS_ADMIN_TOKEN;
        const providedToken = String(body.adminToken || '');
        if (adminToken && (!providedToken || providedToken !== adminToken)) {
            return json(403, { ok: false, error: 'Forbidden: invalid admin token' }, request);
        }
        const id = String(body.id || '');
        const status = body.decision === 'approved' ? 'approved' : body.decision === 'rejected' ? 'rejected' : '';
        if (!id || !status) return json(400, { ok: false, error: 'Missing id or decision' });
        const appeal = appealsStore.find(item => item.id === id);
        if (!appeal) return json(404, { ok: false, error: 'Appeal not found' });
        appeal.status = status;
        appeal.adminMessage = String(body.adminMessage || (status === 'approved' ? 'Апелляция одобрена. Аккаунт разблокирован.' : 'Апелляция отклонена.'));
        appeal.decidedAt = new Date().toISOString();
        return json(200, { ok: true, appeal: publicAppeal(appeal) });
    }

    return json(400, { ok: false, error: 'Unknown action' });
}
