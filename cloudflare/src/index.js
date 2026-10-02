/**
 * PowerWatch Cloudflare Worker
 * Alta Escala a Costo $0.00 con Cloudflare D1 (SQLite)
 */

const BOT_TOKEN = "8541967821:AAGaTrOzPG9s_hRn2VnIOyq7-d21_XwJZ38";
const OFFLINE_THRESHOLD_MS = 300000; // 5 minutos (300 segundos)

// --- HELPERS TELEGRAM ---

async function sendTelegramMessage(chatId, text, customButtons = null) {
    if (!chatId) return { success: false, messageId: null };
    try {
        const buttons = customButtons || [
            [{ text: "📊 Consultar Estado en Vivo", callback_data: "/estado" }],
            [{ text: "📜 Ver Historial de Cortes", callback_data: "/historial" }]
        ];
        const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: String(chatId).trim(),
                text: text,
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: buttons }
            })
        });
        const data = await res.json();
        return { success: data.ok, messageId: data.result?.message_id || null };
    } catch (e) {
        return { success: false, messageId: null };
    }
}

async function answerCallbackQuery(callbackQueryId) {
    if (!callbackQueryId) return;
    try {
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ callback_query_id: callbackQueryId })
        });
    } catch (e) {}
}

async function deleteTelegramMessage(chatId, messageId) {
    if (!chatId || !messageId) return;
    try {
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/deleteMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: String(chatId).trim(), message_id: messageId })
        });
    } catch (e) {}
}

async function sendTelegramReplyKeyboard(chatId, text, keyboard) {
    if (!chatId) return { success: false, messageId: null };
    try {
        const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: String(chatId).trim(),
                text: text,
                parse_mode: 'HTML',
                reply_markup: {
                    keyboard: keyboard,
                    resize_keyboard: true,
                    one_time_keyboard: true
                }
            })
        });
        const data = await res.json();
        return { success: data.ok, messageId: data.result?.message_id || null };
    } catch (e) {
        return { success: false, messageId: null };
    }
}

async function sendTelegramRemoveKeyboard(chatId, text, inlineButtons = []) {
    if (!chatId) return { success: false, messageId: null };
    try {
        const bodyObj = {
            chat_id: String(chatId).trim(),
            text: text,
            parse_mode: 'HTML',
            reply_markup: { remove_keyboard: true }
        };
        const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(bodyObj)
        });
        if (inlineButtons && inlineButtons.length > 0) {
            await sendTelegramMessage(chatId, "👇 Opciones disponibles:", inlineButtons);
        }
        const data = await res.json();
        return { success: data.ok, messageId: data.result?.message_id || null };
    } catch (e) {
        return { success: false, messageId: null };
    }
}

async function reverseGeocode(lat, lon) {
    // 1. Motor Primario: Photon (Komoot) - Alta precisión en avenidas, urbanizaciones y sectores residenciales
    try {
        const pUrl = `https://photon.komoot.io/reverse?lat=${lat}&lon=${lon}`;
        const pRes = await fetch(pUrl, {
            headers: { 'User-Agent': 'PowerWatch-Monitor/1.0 (contact@powerwatch.ve)' },
            signal: AbortSignal.timeout(3500)
        });
        if (pRes.ok) {
            const pData = await pRes.json();
            const feat = pData.features && pData.features[0];
            if (feat && feat.properties) {
                const p = feat.properties;
                const road = p.street || (p.type === 'street' ? p.name : '');
                const sector = p.locality || p.district || '';
                let city = p.city || '';
                if (city.toLowerCase().startsWith('parroquia') && sector) {
                    city = 'Maracay';
                }
                const state = (p.state || '').replace(/^Estado\s+/i, '');
                const parts = [road, sector, city, state].filter(Boolean);
                const addr = [...new Set(parts)].join(', ');
                if (addr && addr.length > 5) return addr;
            }
        }
    } catch (e) {}

    // 2. Motor Secundario: Nominatim OpenStreetMap
    try {
        const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&addressdetails=1`;
        const res = await fetch(url, {
            headers: { 
                'User-Agent': 'PowerWatch-Monitor/1.0 (contact@powerwatch.ve)',
                'Accept-Language': 'es'
            },
            signal: AbortSignal.timeout(3500)
        });
        if (res.ok) {
            const data = await res.json();
            const a = data.address || {};
            const road = a.road || a.pedestrian || a.street || a.highway || '';
            const sector = a.quarter || a.neighbourhood || a.suburb || a.residential || a.subdivision || a.city_district || a.hamlet || '';
            const parroquia = a.municipality || '';
            const city = a.city || a.town || a.village || a.county || '';
            const state = (a.state || '').replace(/^Estado\s+/i, '');
            const parts = [road, sector, parroquia, city, state].filter(Boolean);
            const cleanAddress = [...new Set(parts)].join(', ');
            return cleanAddress || data.display_name || `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
        }
    } catch (e) {}

    return `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
}

// --- HELPERS FECHA Y HORA (Venezuela America/Caracas) ---

function formatVETime(timestamp) {
    const d = new Date(timestamp);
    return d.toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true, timeZone: 'America/Caracas' });
}

function formatVEDate(timestamp) {
    const d = new Date(timestamp);
    return d.toLocaleDateString('es-VE', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'America/Caracas' });
}

function formatDuration(ms) {
    const mins = Math.max(1, Math.round(ms / 60000));
    if (mins <= 1) return "1 min";
    if (mins < 60) return `${mins} min`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return `${h}h ${m}m`;
}

function getWebUrl(devId, chatId = '') {
    const cid = String(chatId || '').trim();
    const cidParam = cid ? `&chatId=${encodeURIComponent(cid)}` : '';
    return `https://monitor-luz-vercel-six.vercel.app/?id=${devId}${cidParam}`;
}

// --- HELPERS IP Y GEOLOCALIZACIÓN ---

function isPrivateIp(ip) {
    if (!ip) return true;
    const str = String(ip).trim();
    return str.startsWith('10.') || str.startsWith('192.168.') || 
           /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(str) || 
           str === '127.0.0.1' || str === '0.0.0.0' || str === '::1';
}

function isDatacenter(city, isp) {
    const c = String(city || '').toLowerCase();
    const i = String(isp || '').toLowerCase();
    const datacenterKeywords = [
        'ashburn', 'seattle', 'amazon', 'vercel', 'cloudflare', 'google', 
        'microsoft', 'datacenter', 'hosting', 'ovh', 'digitalocean', 
        'fastly', 'hetzner', 'linode', 'oracle', 'akamai'
    ];
    return datacenterKeywords.some(k => c.includes(k) || i.includes(k));
}

function getClientIp(request) {
    // 1. Cabeceras de proxy (Vercel pasa la IP real del ESP en x-forwarded-for)
    const xff = request.headers.get('x-forwarded-for');
    if (xff) {
        const parts = xff.split(',').map(p => p.trim());
        if (parts[0] && !isPrivateIp(parts[0])) return parts[0];
        for (const p of parts) {
            if (p && !isPrivateIp(p)) return p;
        }
    }
    const xReal = request.headers.get('x-real-ip') || request.headers.get('x-vercel-forwarded-for');
    if (xReal && !isPrivateIp(xReal.trim())) {
        return xReal.trim();
    }
    return request.headers.get('cf-connecting-ip') || '0.0.0.0';
}

const KNOWN_DEVICE_GEO = {
    'ESP-51A1B1': { city: 'Maracay', region: 'Aragua', sector: 'Las Delicias', isp: 'FIBEX TELECOM' },
    'ESP-3641CA': { city: 'Maracay', region: 'Aragua', sector: 'El Castaño', isp: 'INTER' },
    'ESP-D73804': { city: 'Maracay', region: 'Aragua', sector: 'Av. Bermúdez', isp: 'FIBEX TELECOM' },
    'ESP-7A562F': { city: 'Turmero', region: 'Aragua', sector: 'Turmero', isp: 'NERVICOM' },
    'ESP-367399': { city: 'Caracas', region: 'Dtto. Capital', sector: 'Caracas', isp: 'INTER' },
};

async function resolveGeo(request, clientIp, existing, deviceId) {
    const devId = (deviceId || '').toUpperCase();
    if (KNOWN_DEVICE_GEO[devId]) {
        return {
            city: KNOWN_DEVICE_GEO[devId].city,
            region: KNOWN_DEVICE_GEO[devId].region,
            sector: KNOWN_DEVICE_GEO[devId].sector,
            isp: KNOWN_DEVICE_GEO[devId].isp
        };
    }

    // 1. Si el dispositivo ya tiene ubicación venezolana válida (no datacenter), mantenerla siempre
    const existingValid = existing && existing.city && !isDatacenter(existing.city, existing.isp);
    if (existingValid) {
        const isp = request.cf?.asOrganization || existing.isp || '';
        return {
            city: existing.city,
            region: existing.region || '',
            isp: isp
        };
    }

    // 2. Si la petición vino directa a Cloudflare con datos válidos
    const cfCity = request.cf?.city;
    const cfRegion = request.cf?.region;
    const cfIsp = request.cf?.asOrganization;
    if (cfCity && !isDatacenter(cfCity, cfIsp) && (request.cf?.country === 'VE' || !isDatacenter('', cfIsp))) {
        return {
            city: cfCity,
            region: cfRegion || '',
            isp: cfIsp || ''
        };
    }

    // 3. Consultar ip-api.com con la IP real del cliente
    if (clientIp && !isPrivateIp(clientIp) && !isDatacenter('', clientIp)) {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 1500);
            const res = await fetch(`http://ip-api.com/json/${clientIp}?fields=status,country,regionName,city,isp`, {
                signal: controller.signal
            });
            clearTimeout(timeout);
            if (res.ok) {
                const data = await res.json();
                if (data.status === 'success' && !isDatacenter(data.city, data.isp)) {
                    return {
                        city: data.city || (existingValid ? existing.city : 'Venezuela'),
                        region: data.regionName || (existingValid ? existing.region : ''),
                        isp: data.isp || (existingValid ? existing.isp : '')
                    };
                }
            }
        } catch (e) {
            console.error('Geo lookup error:', e);
        }
    }

    // 4. Fallback de seguridad: mantener datos existentes si eran válidos, nunca poner datacenter
    return {
        city: existingValid ? existing.city : (existing?.city || 'Venezuela'),
        region: existingValid ? existing.region : (existing?.region || ''),
        isp: existingValid ? existing.isp : (existing?.isp || '')
    };
}

// --- D1 DATABASE OPERATIONS ---

async function getDeviceFull(db, deviceId) {
    const devId = String(deviceId || '').toUpperCase().trim();
    if (!devId) return null;

    const dev = await db.prepare("SELECT * FROM devices WHERE device_id = ?").bind(devId).first();
    if (!dev) return null;

    const guestsRows = await db.prepare("SELECT guest_chat_id, guest_name FROM guests WHERE device_id = ?").bind(devId).all();
    const guestChatIds = [];
    const guestNames = {};
    for (const g of (guestsRows.results || [])) {
        guestChatIds.push(String(g.guest_chat_id).trim());
        if (g.guest_name) guestNames[String(g.guest_chat_id).trim()] = g.guest_name;
    }

    const historyRows = await db.prepare("SELECT * FROM history WHERE device_id = ? ORDER BY start_time DESC LIMIT 30").bind(devId).all();
    const history = (historyRows.results || []).map(h => ({
        id: h.id,
        start: h.start_time,
        end: h.end_time,
        startTimeStr: h.start_time_str,
        endTimeStr: h.end_time_str,
        startDateStr: h.start_date_str,
        endDateStr: h.end_date_str,
        durationStr: h.duration_str,
        durationMs: h.duration_ms,
        type: h.event_type
    }));

    let lastAlertMessages = {};
    try { lastAlertMessages = JSON.parse(dev.last_alert_messages || '{}'); } catch(e) {}

    let effectiveOnlineSince = dev.online_since || 0;
    if (history && history.length > 0) {
        const lastEndedCut = history.find(h => h && h.end);
        if (lastEndedCut && lastEndedCut.end && lastEndedCut.end > effectiveOnlineSince) {
            effectiveOnlineSince = lastEndedCut.end;
        }
    }

    return {
        deviceId: dev.device_id,
        alias: dev.alias || dev.device_id,
        chatId: dev.chat_id || '',
        lastSeen: dev.last_seen || 0,
        onlineSince: effectiveOnlineSince,
        blackoutNotified: Boolean(dev.blackout_notified),
        blackoutStartTime: dev.blackout_start_time || null,
        lastAlertMessageId: dev.last_alert_msg_id || null,
        lastAlertMessages: lastAlertMessages,
        ip: dev.ip || '',
        city: dev.city || '',
        region: dev.region || '',
        isp: dev.isp || '',
        latitude: dev.latitude || null,
        longitude: dev.longitude || null,
        address: dev.address || '',
        locationLocked: Boolean(dev.location_locked),
        unlinked: Boolean(dev.unlinked),
        resetRequested: Boolean(dev.reset_requested),
        updatedAt: dev.updated_at || 0,
        guestChatIds: guestChatIds,
        guestNames: guestNames,
        history: history
    };
}

async function getDeviceFast(db, deviceId) {
    const devId = String(deviceId || '').toUpperCase().trim();
    if (!devId) return null;
    const dev = await db.prepare(`
        SELECT d.*, 
               (SELECT MAX(h.end_time) FROM history h WHERE h.device_id = d.device_id AND h.end_time IS NOT NULL) as last_cut_end
        FROM devices d 
        WHERE d.device_id = ?
    `).bind(devId).first();
    if (!dev) return null;
    const effectiveOnlineSince = Math.max(dev.online_since || 0, dev.last_cut_end || 0) || dev.last_seen || 0;
    return {
        deviceId: dev.device_id,
        alias: dev.alias || dev.device_id,
        chatId: dev.chat_id || '',
        lastSeen: dev.last_seen || 0,
        onlineSince: effectiveOnlineSince,
        blackoutNotified: Boolean(dev.blackout_notified),
        blackoutStartTime: dev.blackout_start_time || null,
        lastAlertMsgId: dev.last_alert_msg_id || null,
        ip: dev.ip || '',
        city: dev.city || '',
        region: dev.region || '',
        isp: dev.isp || '',
        latitude: dev.latitude || null,
        longitude: dev.longitude || null,
        address: dev.address || '',
        locationLocked: Boolean(dev.location_locked),
        unlinked: Boolean(dev.unlinked),
        resetRequested: Boolean(dev.reset_requested),
        updatedAt: dev.updated_at || 0
    };
}

async function getDevicesForUser(db, chatId) {
    let reqId = String(chatId || '').trim();
    if (!reqId) return [];
    if (reqId === '3307499449') reqId = '330749449';

    const rows = await db.prepare(`
        SELECT * FROM devices WHERE chat_id = ?
        UNION
        SELECT d.* FROM devices d JOIN guests g ON d.device_id = g.device_id WHERE g.guest_chat_id = ?
        ORDER BY device_id ASC
    `).bind(reqId, reqId).all();

    const results = [];
    for (const dev of (rows.results || [])) {
        const guestsRows = await db.prepare("SELECT guest_chat_id, guest_name FROM guests WHERE device_id = ?").bind(dev.device_id).all();
        const guestChatIds = [];
        const guestNames = {};
        for (const g of (guestsRows.results || [])) {
            guestChatIds.push(String(g.guest_chat_id).trim());
            if (g.guest_name) guestNames[String(g.guest_chat_id).trim()] = g.guest_name;
        }

        const historyRows = await db.prepare("SELECT * FROM history WHERE device_id = ? ORDER BY start_time DESC LIMIT 15").bind(dev.device_id).all();
        const history = (historyRows.results || []).map(h => ({
            id: h.id,
            start: h.start_time,
            end: h.end_time,
            startTimeStr: h.start_time_str,
            endTimeStr: h.end_time_str,
            startDateStr: h.start_date_str,
            endDateStr: h.end_date_str,
            durationStr: h.duration_str,
            durationMs: h.duration_ms,
            type: h.event_type
        }));

        let lastAlertMessages = {};
        try { lastAlertMessages = JSON.parse(dev.last_alert_messages || '{}'); } catch(e) {}

        let effectiveOnlineSince = dev.online_since || dev.last_seen || 0;
        if (history && history.length > 0) {
            const lastEndedCut = history.find(h => h && h.end);
            if (lastEndedCut && lastEndedCut.end && lastEndedCut.end > effectiveOnlineSince) {
                effectiveOnlineSince = lastEndedCut.end;
            }
        }

        results.push({
            deviceId: dev.device_id,
            alias: dev.alias || dev.device_id,
            chatId: dev.chat_id || '',
            lastSeen: dev.last_seen || 0,
            onlineSince: effectiveOnlineSince,
            blackoutNotified: Boolean(dev.blackout_notified),
            blackoutStartTime: dev.blackout_start_time || null,
            lastAlertMsgId: dev.last_alert_msg_id || null,
            lastAlertMessages: lastAlertMessages,
            ip: dev.ip || '',
            city: dev.city || '',
            region: dev.region || '',
            isp: dev.isp || '',
            latitude: dev.latitude || null,
            longitude: dev.longitude || null,
            address: dev.address || '',
            locationLocked: Boolean(dev.location_locked),
            unlinked: Boolean(dev.unlinked),
            resetRequested: Boolean(dev.reset_requested),
            updatedAt: dev.updated_at || 0,
            guestChatIds: guestChatIds,
            guestNames: guestNames,
            history: history
        });
    }
    return results;
}

async function getAllDevicesOptimized(db) {
    const devsRows = await db.prepare(`
        SELECT d.*, 
               (SELECT MAX(h.end_time) FROM history h WHERE h.device_id = d.device_id AND h.end_time IS NOT NULL) as last_cut_end
        FROM devices d 
        ORDER BY device_id ASC
    `).all();
    const guestsRows = await db.prepare("SELECT device_id, guest_chat_id, guest_name FROM guests").all();

    const guestsByDevice = {};
    const guestNamesByDevice = {};
    for (const g of (guestsRows.results || [])) {
        const dId = g.device_id;
        if (!guestsByDevice[dId]) guestsByDevice[dId] = [];
        if (!guestNamesByDevice[dId]) guestNamesByDevice[dId] = {};
        guestsByDevice[dId].push(String(g.guest_chat_id).trim());
        if (g.guest_name) guestNamesByDevice[dId][String(g.guest_chat_id).trim()] = g.guest_name;
    }

    return (devsRows.results || []).map(dev => ({
        deviceId: dev.device_id,
        alias: dev.alias || dev.device_id,
        chatId: dev.chat_id || '',
        lastSeen: dev.last_seen || 0,
        onlineSince: Math.max(dev.online_since || 0, dev.last_cut_end || 0) || dev.last_seen || 0,
        blackoutNotified: Boolean(dev.blackout_notified),
        blackoutStartTime: dev.blackout_start_time || null,
        lastAlertMsgId: dev.last_alert_msg_id || null,
        ip: dev.ip || '',
        city: dev.city || '',
        region: dev.region || '',
        isp: dev.isp || '',
        latitude: dev.latitude || null,
        longitude: dev.longitude || null,
        address: dev.address || '',
        locationLocked: Boolean(dev.location_locked),
        unlinked: Boolean(dev.unlinked),
        resetRequested: Boolean(dev.reset_requested),
        updatedAt: dev.updated_at || 0,
        guestChatIds: guestsByDevice[dev.device_id] || [],
        guestNames: guestNamesByDevice[dev.device_id] || {},
        history: []
    }));
}

async function getAllDevicesFull(db) {
    return await getAllDevicesOptimized(db);
}

// Helper: verificar titular
function checkIsOwner(dev, chatId, strict = false) {
    if (!dev) return !strict;
    let reqId = String(chatId || '').trim();
    let devOwnerId = String(dev.chatId || '').trim();
    if (reqId === '3307499449') reqId = '330749449';
    if (devOwnerId === '3307499449') devOwnerId = '330749449';

    const guests = (dev.guestChatIds || []).map(g => {
        let id = String(g).trim();
        return id === '3307499449' ? '330749449' : id;
    });

    if (reqId && guests.includes(reqId)) return false;
    if (reqId && devOwnerId && reqId === devOwnerId) return true;
    if (strict) return false;
    return !devOwnerId;
}

function getGuestName(dev, guestChatId) {
    const cid = String(guestChatId || '').trim();
    if (!cid || !dev) return null;
    return (dev.guestNames && dev.guestNames[cid]) || null;
}

// --- MENSAJES FORMATEADOS ---

function buildStatusMsg(dev, devId, targetChatId = '') {
    if (!dev) return `⚠️ <b>Dispositivo no encontrado:</b> <code>${devId || 'ESP-DESCONOCIDO'}</code>`;
    const now = Date.now();
    const lastSeen = dev.lastSeen || now;
    const elapsed = now - lastSeen;
    const online = elapsed < OFFLINE_THRESHOLD_MS;
    const name = dev.alias || dev.deviceId || devId;
    const activeDevId = dev.deviceId || devId;
    const webLink = getWebUrl(activeDevId, targetChatId || dev.chatId);

    const isOwner = checkIsOwner(dev, targetChatId);
    const roleTag = isOwner ? '👑 Propietario' : '👤 Invitado';

    const known = KNOWN_DEVICE_GEO[activeDevId];
    const devCity = (known && known.city) ? known.city : dev.city;
    const devRegion = (known && known.region) ? known.region : dev.region;
    const devIsp = (known && known.isp) ? known.isp : ((dev.isp && !isDatacenter('', dev.isp)) ? dev.isp : '');

    let geoInfo = (devCity && devIsp) ? 
        `🏢 <b>Ciudad:</b> ${devCity}, ${devRegion || ''}\n` +
        `🌐 <b>Red:</b> ${devIsp}\n` : '';
    if (dev.address) {
        geoInfo += `📍 <b>Ubicación:</b> ${dev.address}\n`;
    }

    let effectiveOnlineSince = dev.onlineSince || lastSeen;
    if (dev.history && dev.history.length > 0) {
        const lastEndedCut = dev.history.find(h => h && (h.end || h.end_time));
        const cutEnd = lastEndedCut ? (lastEndedCut.end || lastEndedCut.end_time) : 0;
        if (cutEnd && cutEnd > effectiveOnlineSince) {
            effectiveOnlineSince = cutEnd;
        }
    }

    if (online) {
        const up = Math.max(0, now - effectiveOnlineSince);
        const h = Math.floor(up / 3600000);
        const m = Math.floor((up % 3600000) / 60000);
        const uptimeStr = h > 0 ? `${h}h ${m}m` : `${m}m`;
        return `🟢 <b>ESTADO EN VIVO: HAY LUZ ⚡</b>\n\n` +
               `📍 <b>Ubicación:</b> <b>${name}</b> [${roleTag}]\n` +
               `👤 <b>Tu Rol:</b> ${isOwner ? '👑 Propietario (Titular)' : '👤 Familiar Invitado'}\n` +
               geoInfo +
               `📱 <b>ID:</b> <code>${activeDevId}</code>\n` +
               `⏱️ <b>Tiempo continuo con luz:</b> ${uptimeStr}\n` +
               `📡 <b>Último reporte:</b> Hace ${Math.max(0, Math.floor(elapsed / 1000))} segundos\n\n` +
               `🔗 <b>Monitor Web:</b> ${webLink}`;
    } else {
        const t = formatDuration(elapsed);
        const ts = formatVETime(lastSeen);
        const ds = formatVEDate(lastSeen);
        return `🔴 <b>ESTADO EN VIVO: SE FUE LA LUZ 🔌</b>\n\n` +
               `📍 <b>Ubicación:</b> <b>${name}</b> [${roleTag}]\n` +
               `👤 <b>Tu Rol:</b> ${isOwner ? '👑 Propietario (Titular)' : '👤 Familiar Invitado'}\n` +
               geoInfo +
               `📱 <b>ID:</b> <code>${activeDevId}</code>\n` +
               `🕐 <b>Último reporte:</b> ${ts} (${ds})\n` +
               `⏱️ <b>Tiempo sin luz:</b> ${t}\n\n` +
               `🔗 <b>Monitor Web:</b> ${webLink}`;
    }
}

function buildHistoryMsg(dev, targetChatId = '') {
    if (!dev) return '⚠️ <b>Dispositivo no encontrado.</b>';
    const name = dev.alias || dev.deviceId;
    const history = dev.history || [];
    const webLink = getWebUrl(dev.deviceId, targetChatId || dev.chatId);
    const isOwner = checkIsOwner(dev, targetChatId);
    const roleTag = isOwner ? '👑 Propietario' : '👤 Invitado';

    if (history.length === 0) {
        return `📜 <b>HISTORIAL DE CORTES ELÉCTRICOS</b>\n\n` +
               `📍 <b>Ubicación:</b> <b>${name}</b> [${roleTag}]\n` +
               `👤 <b>Tu Rol:</b> ${isOwner ? '👑 Propietario (Titular)' : '👤 Familiar Invitado'}\n` +
               `📱 <b>Dispositivo:</b> <code>${dev.deviceId}</code>\n\n` +
               `✨ <i>No hay registros de cortes de luz almacenados. ¡El suministro ha estado estable!</i>\n\n` +
               `🔗 <b>Ver en Web:</b> ${webLink}`;
    }

    let historyListText = "";
    const maxShow = Math.min(history.length, 5);
    for (let i = 0; i < maxShow; i++) {
        const h = history[i];
        let icon = "⚡";
        let tagLabel = "Corte Eléctrico";
        if (!h.end) {
            icon = "🔴";
            tagLabel = "En Curso";
        } else if (h.type === 'internet_drop') {
            icon = "🌐";
            tagLabel = "Caída de Internet";
        } else if (h.type === 'fluctuation') {
            icon = "〽️";
            tagLabel = "Fluctuación / Bajón";
        }

        historyListText += `${icon} <b>${tagLabel} #${history.length - i}:</b>\n` +
                           `   • <b>Inicio:</b> ${h.startTimeStr || 'N/A'} (${h.startDateStr || 'N/A'})\n` +
                           `   • <b>Fin:</b> ${h.endTimeStr ? `${h.endTimeStr} (${h.endDateStr || ''})` : '<i>En curso...</i>'}\n` +
                           `   • <b>Duración:</b> <code>${h.durationStr || 'N/A'}</code>\n\n`;
    }

    return `📜 <b>HISTORIAL DE EVENTOS</b>\n\n` +
           `📍 <b>Ubicación:</b> <b>${name}</b>\n` +
           `📊 <b>Total de eventos registrados:</b> ${history.length}\n\n` +
           historyListText +
           `🔗 <b>Ver y gestionar en la Web:</b>\n${webLink}`;
}

function buildWeeklyReport(device, targetChatId = '') {
    if (!device) return null;
    const now = Date.now();
    const oneWeekAgo = now - 7 * 24 * 60 * 60 * 1000;
    const history = device.history || [];
    const weekEvents = history.filter(h => (h.start && h.start >= oneWeekAgo) || (h.end && h.end >= oneWeekAgo));

    let totalBlackoutMs = 0;
    let longCutsCount = 0;
    let microCutsCount = 0;
    let longestCutMs = 0;

    weekEvents.forEach(e => {
        const dur = e.durationMs || (e.end ? (e.end - e.start) : 0);
        totalBlackoutMs += dur;
        if (dur >= 300000) longCutsCount++;
        else if (dur > 0) microCutsCount++;
        if (dur > longestCutMs) longestCutMs = dur;
    });

    const totalWeekMs = 7 * 24 * 60 * 60 * 1000;
    const blackoutHours = (totalBlackoutMs / 3600000).toFixed(1);
    const lightHours = ((totalWeekMs - totalBlackoutMs) / 3600000).toFixed(1);
    const stabilityPct = Math.max(0, Math.min(100, ((totalWeekMs - totalBlackoutMs) / totalWeekMs * 100).toFixed(1)));

    let diagnostic = "🌟 <b>Excelente:</b> Suministro eléctrico continuo sin cortes significativos.";
    if (stabilityPct < 80) diagnostic = "🚨 <b>Crítico:</b> Frecuencia severa de cortes eléctricos esta semana.";
    else if (stabilityPct < 95) diagnostic = "⚠️ <b>Inestable:</b> Se registraron varias interrupciones en el servicio.";

    const longestCutStr = formatDuration(longestCutMs);

    return `📊 <b>REPORTE SEMANAL DE ENERGÍA ELÉCTRICA</b>\n` +
           `📅 <i>Últimos 7 días</i>\n\n` +
           `📍 <b>Ubicación:</b> <b>${device.alias || device.deviceId}</b>\n` +
           `📱 <b>Dispositivo:</b> <code>${device.deviceId}</code>\n` +
           `━━━━━━━━━━━━━━━━━━━━\n\n` +
           `🟢 <b>Tiempo con Luz:</b> ${lightHours}h (<code>${stabilityPct}%</code>)\n` +
           `🔴 <b>Tiempo sin Luz:</b> ${blackoutHours}h\n\n` +
           `📈 <b>Desglose de la Semana:</b>\n` +
           `• 🔌 <b>Cortes Eléctricos (>5m):</b> ${longCutsCount}\n` +
           `• ⏱️ <b>Corte más largo:</b> ${longestCutStr}\n` +
           `• 〽️ <b>Fluctuaciones / Bajones:</b> ${microCutsCount}\n\n` +
           `💡 <b>Diagnóstico:</b>\n${diagnostic}\n\n` +
           `🔗 <b>Ver Monitor Web:</b>\n${getWebUrl(device.deviceId, targetChatId || device.chatId)}`;
}

// --- COMANDOS WEBHOOK TELEGRAM ---

async function handleTelegramWebhook(request, env) {
    try {
        const update = await request.json();
        if (!update) return new Response('OK', { status: 200 });

        let chatId = null;
        let text = '';
        let senderName = 'Usuario';
        let callbackQueryId = null;

        if (update.callback_query) {
            chatId = String(update.callback_query.message.chat.id || '');
            text = String(update.callback_query.data || '').toLowerCase().trim();
            senderName = (update.callback_query.from && update.callback_query.from.first_name) || 'Usuario';
            callbackQueryId = update.callback_query.id;
            await answerCallbackQuery(callbackQueryId);
        } else if (update.message && update.message.chat) {
            chatId = String(update.message.chat.id || '');
            text = String(update.message.text || '').toLowerCase().trim();
            senderName = (update.message.from && update.message.from.first_name) || 'Usuario';
        }

        if (!chatId) return new Response('OK', { status: 200 });
        if (chatId === '3307499449') chatId = '330749449';

        const cleanText = (update.message && update.message.text) ? update.message.text.trim() : text;
        const myDevs = await getDevicesForUser(env.DB, chatId);
        const devs = myDevs;

        const deviceMap = {};
        for (const d of myDevs) {
            deviceMap[d.deviceId.toUpperCase()] = d;
        }

        const getDevice = (id) => {
            const norm = String(id || '').toUpperCase().trim();
            return deviceMap[norm] || null;
        };
        const getMyDevs = () => myDevs;

        // Gestión de estados pendientes
        let pending = null;
        const pendingRow = await env.DB.prepare("SELECT state_json FROM pending_states WHERE chat_id = ?").bind(chatId).first();
        if (pendingRow) {
            try { pending = JSON.parse(pendingRow.state_json); } catch(e) {}
        }

        if (pending && cleanText.startsWith('/') && !cleanText.startsWith('/skip_guest_name_')) {
            await env.DB.prepare("DELETE FROM pending_states WHERE chat_id = ?").bind(chatId).run();
            pending = null;
        }

        // 1. PENDIENTE: AGREGAR FAMILIAR
        if (pending && pending.action === 'ADD_GUEST_CHAT_ID' && /^\d+$/.test(cleanText)) {
            const devId = pending.devId;
            const guestChatId = cleanText;
            const existingDev = getDevice(devId);

            if (!checkIsOwner(existingDev, chatId, true)) {
                await env.DB.prepare("DELETE FROM pending_states WHERE chat_id = ?").bind(chatId).run();
                await sendTelegramMessage(chatId, `⛔ <b>Acceso Denegado:</b> Solo el Propietario (Titular) puede agregar familiares.`, []);
                return new Response('OK', { status: 200 });
            }

            await env.DB.prepare("INSERT OR REPLACE INTO guests (device_id, guest_chat_id, guest_name) VALUES (?, ?, '')").bind(devId, guestChatId).run();
            await env.DB.prepare("UPDATE devices SET updated_at = ? WHERE device_id = ?").bind(Date.now(), devId).run();

            const nextState = { action: 'SET_GUEST_NAME', devId: devId, guestChatId: guestChatId };
            await env.DB.prepare("INSERT OR REPLACE INTO pending_states (chat_id, state_json, updated_at) VALUES (?, ?, ?)").bind(chatId, JSON.stringify(nextState), Date.now()).run();

            await sendTelegramMessage(chatId,
                `✅ <b>¡Chat ID registrado!</b> (<code>${guestChatId}</code>)\n\n` +
                `📍 <b>Monitor:</b> <b>${existingDev.alias || devId}</b> (<code>${devId}</code>)\n\n` +
                `✏️ Ahora escribe el <b>Nombre o Parentesco</b> de esta persona (ej: <i>Pedro</i>, <i>Mamá</i>, <i>José</i>):`,
                [[{ text: '⏭️ Omitir / Guardar sin nombre', callback_data: `/skip_guest_name_${devId}_${guestChatId}` }]]
            );
            return new Response('OK', { status: 200 });
        }

        // 2. PENDIENTE: ASIGNAR NOMBRE FAMILIAR
        if (pending && (pending.action === 'SET_GUEST_NAME' || pending.action === 'RENAME_GUEST') && cleanText.length > 0 && !cleanText.startsWith('/')) {
            const devId = pending.devId;
            const guestChatId = pending.guestChatId;
            const guestName = cleanText.trim();
            await env.DB.prepare("DELETE FROM pending_states WHERE chat_id = ?").bind(chatId).run();

            const existingDev = getDevice(devId);
            if (!checkIsOwner(existingDev, chatId, true)) {
                await sendTelegramMessage(chatId, `⛔ <b>Acceso Denegado:</b> Solo el Propietario puede gestionar familiares.`, []);
                return new Response('OK', { status: 200 });
            }

            await env.DB.prepare("INSERT OR REPLACE INTO guests (device_id, guest_chat_id, guest_name) VALUES (?, ?, ?)").bind(devId, guestChatId, guestName).run();
            await env.DB.prepare("UPDATE devices SET updated_at = ? WHERE device_id = ?").bind(Date.now(), devId).run();

            await sendTelegramMessage(chatId,
                `🎉 <b>¡Familiar configurado con éxito!</b>\n\n` +
                `👤 <b>Nombre:</b> <b>${guestName}</b>\n` +
                `👥 <b>Chat ID:</b> <code>${guestChatId}</code>\n` +
                `📍 <b>Monitor:</b> <b>${existingDev.alias || devId}</b> (<code>${devId}</code>)\n\n` +
                `Esta persona ahora recibirá alertas automáticas cada vez que se vaya o regrese la luz en este monitor.`,
                [
                    [{ text: '👥 Gestión de Familiares', callback_data: '/invitar' }],
                    [{ text: '🏠 Mis Monitores', callback_data: '/casas' }]
                ]
            );

            sendTelegramMessage(guestChatId,
                `👋 <b>¡Hola! Has sido agregado como familiar</b> al monitor <b>${existingDev.alias || devId}</b> por su propietario.\n\n` +
                `A partir de ahora recibirás alertas automáticas en este chat cada vez que se vaya o regrese la luz.`,
                [[{ text: '📊 Consultar Estado', callback_data: `/estado_${devId}` }]]
            ).catch(() => {});
            return new Response('OK', { status: 200 });
        }

        // 3. PENDIENTE: RENOMBRAR MONITOR
        if (pending && pending.action === 'RENAME_MONITOR' && cleanText.length > 0 && !cleanText.startsWith('/')) {
            const renameDevId = pending.devId;
            await env.DB.prepare("DELETE FROM pending_states WHERE chat_id = ?").bind(chatId).run();

            const existingDev = getDevice(renameDevId);
            if (!checkIsOwner(existingDev, chatId, true)) {
                await sendTelegramMessage(chatId, `⛔ <b>Acceso Denegado:</b> Solo el Propietario puede renombrar este monitor.`, []);
                return new Response('OK', { status: 200 });
            }

            const newAlias = cleanText.trim();
            await env.DB.prepare("UPDATE devices SET alias = ?, updated_at = ? WHERE device_id = ?").bind(newAlias, Date.now(), renameDevId).run();

            await sendTelegramMessage(chatId,
                `✅ <b>¡Nombre actualizado con éxito!</b>\n\n📍 Ahora tu monitor <code>${renameDevId}</code> se llama: <b>${newAlias}</b>`,
                [
                    [{ text: "📊 Ver Estado en Vivo", callback_data: `/estado_${renameDevId}` }],
                    [{ text: "🏠 Mis Monitores", callback_data: "/casas" }]
                ]
            );
            return new Response('OK', { status: 200 });
        }

        // 3b. PENDIENTE: EDITAR DIRECCIÓN ESCRITA
        if (pending && pending.action === 'SET_ADDRESS' && cleanText.length > 0 && !cleanText.startsWith('/')) {
            const addrDevId = pending.devId;
            await env.DB.prepare("DELETE FROM pending_states WHERE chat_id = ?").bind(chatId).run();

            const existingDev = getDevice(addrDevId) || await getDeviceFast(env.DB, addrDevId);
            if (!checkIsOwner(existingDev, chatId, true)) {
                await sendTelegramMessage(chatId, `⛔ <b>Acceso Denegado:</b> Solo el Propietario o Administrador puede editar la dirección.`, []);
                return new Response('OK', { status: 200 });
            }

            const newAddress = cleanText.trim();
            await env.DB.prepare("UPDATE devices SET address = ?, updated_at = ? WHERE device_id = ?").bind(newAddress, Date.now(), addrDevId).run();

            await sendTelegramMessage(chatId,
                `✅ <b>¡Dirección actualizada con éxito!</b>\n\n📍 <b>Monitor:</b> <b>${existingDev?.alias || addrDevId}</b>\n🗺️ <b>Nueva Dirección:</b>\n<i>${newAddress}</i>`,
                [
                    [{ text: "📊 Ver Estado en Vivo", callback_data: `/estado_${addrDevId}` }],
                    [{ text: "🏠 Mis Monitores", callback_data: "/casas" }]
                ]
            );
            return new Response('OK', { status: 200 });
        }

        // 4. PENDIENTE: FIJAR UBICACIÓN GPS
        if (pending && pending.action === 'SET_LOCATION') {
            if (update.message && update.message.location) {
                const locDevId = pending.devId;
                await env.DB.prepare("DELETE FROM pending_states WHERE chat_id = ?").bind(chatId).run();
                const existingDev = getDevice(locDevId);
                if (!checkIsOwner(existingDev, chatId, true)) {
                    await sendTelegramRemoveKeyboard(chatId, `⛔ <b>Acceso Denegado:</b> Solo el Propietario puede fijar la ubicación.`);
                    return new Response('OK', { status: 200 });
                }

                const lat = update.message.location.latitude;
                const lon = update.message.location.longitude;
                const address = await reverseGeocode(lat, lon);

                await env.DB.prepare("UPDATE devices SET latitude = ?, longitude = ?, address = ?, location_locked = 1, updated_at = ? WHERE device_id = ?")
                    .bind(lat, lon, address, Date.now(), locDevId).run();

                const devName = existingDev?.alias || locDevId;
                await sendTelegramRemoveKeyboard(chatId,
                    `📍 <b>¡Ubicación fijada con éxito!</b>\n\n` +
                    `🏠 <b>Monitor:</b> <b>${devName}</b> (<code>${locDevId}</code>)\n` +
                    `📌 <b>Coordenadas:</b> <code>${lat.toFixed(5)}, ${lon.toFixed(5)}</code>\n` +
                    `🗺️ <b>Dirección aproximada:</b>\n<i>${address}</i>\n\n` +
                    `🔒 <b>Ubicación protegida:</b> Ha quedado bloqueada permanentemente para evitar cambios accidentales si sales de casa (por ejemplo, si estás en la playa o de viaje). Solo el administrador puede desbloquearla si te mudas.`,
                    [
                        [{ text: "📊 Ver Estado en Vivo", callback_data: `/estado_${locDevId}` }],
                        [{ text: "🏠 Mis Monitores", callback_data: "/casas" }]
                    ]
                );
                return new Response('OK', { status: 200 });
            } else if (cleanText.toLowerCase().includes('cancelar') || cleanText.toLowerCase().includes('omitir')) {
                await env.DB.prepare("DELETE FROM pending_states WHERE chat_id = ?").bind(chatId).run();
                await sendTelegramRemoveKeyboard(chatId, `❌ <b>Operación cancelada.</b> No se modificó la ubicación.`, [
                    [{ text: "🏠 Mis Monitores", callback_data: "/casas" }]
                ]);
                return new Response('OK', { status: 200 });
            }
        }

        // --- COMANDOS Y MENÚS TELEGRAM ---

        if (text.startsWith('/skip_guest_name_')) {
            const parts = text.replace('/skip_guest_name_', '').split('_');
            const devId = (parts[0] || '').toUpperCase().trim();
            const guestChatId = (parts[1] || '').trim();
            await env.DB.prepare("DELETE FROM pending_states WHERE chat_id = ?").bind(chatId).run();

            const dev = getDevice(devId);
            await sendTelegramMessage(chatId,
                `✅ <b>Familiar guardado (sin nombre asignado):</b>\n\n` +
                `👥 <b>Chat ID:</b> <code>${guestChatId}</code>\n` +
                `📍 <b>Monitor:</b> <b>${dev?.alias || devId}</b>\n\n` +
                `Recibirá todas las alertas de luz normalmente. Puedes asignarle un nombre en cualquier momento desde /invitar.`,
                [
                    [{ text: '👥 Gestión de Familiares', callback_data: '/invitar' }],
                    [{ text: '🏠 Mis Monitores', callback_data: '/casas' }]
                ]
            );

        } else if (text.startsWith('/pedirinvitado_')) {
            const devId = text.replace('/pedirinvitado_', '').toUpperCase().trim();
            const dev = getDevice(devId);

            if (!checkIsOwner(dev, chatId, true)) {
                await sendTelegramMessage(chatId, `⛔ <b>Acceso Denegado:</b> Solo el Propietario puede agregar familiares.`, []);
                return new Response('OK', { status: 200 });
            }

            const state = { action: 'ADD_GUEST_CHAT_ID', devId: devId };
            await env.DB.prepare("INSERT OR REPLACE INTO pending_states (chat_id, state_json, updated_at) VALUES (?, ?, ?)").bind(chatId, JSON.stringify(state), Date.now()).run();

            await sendTelegramMessage(chatId,
                `👥 <b>AGREGAR FAMILIAR / INVITADO</b>\n\n` +
                `📍 <b>Monitor:</b> <b>${dev?.alias || devId}</b> (<code>${devId}</code>)\n\n` +
                `👉 Por favor, <b>escribe o pega el Chat ID de Telegram</b> de la persona que deseas agregar.\n\n` +
                `💡 <i>(Dile a tu familiar que le hable a este bot y pulse /chatid para saber su número)</i>:`,
                [[{ text: '❌ Cancelar', callback_data: '/invitar' }]]
            );

        } else if (text.startsWith('/quitarinvitado_')) {
            const devId = text.replace('/quitarinvitado_', '').toUpperCase().trim();
            const dev = getDevice(devId);

            if (!checkIsOwner(dev, chatId, true)) {
                await sendTelegramMessage(chatId, `⛔ <b>Acceso Denegado:</b> Solo el Propietario puede gestionar familiares.`, []);
                return new Response('OK', { status: 200 });
            }

            const guests = dev?.guestChatIds || [];
            if (guests.length === 0) {
                await sendTelegramMessage(chatId, `ℹ️ El monitor <b>${dev?.alias || devId}</b> no tiene familiares registrados.`, []);
                return new Response('OK', { status: 200 });
            }

            let listMsg = `❌ <b>ELIMINAR FAMILIAR</b>\n\n📍 <b>Monitor:</b> <b>${dev?.alias || devId}</b>\n\nSelecciona el familiar que deseas eliminar:`;
            const buttons = guests.map(gId => {
                const gName = getGuestName(dev, gId) || `Chat ID ${gId}`;
                return [{ text: `🗑️ Eliminar ${gName}`, callback_data: `/delguest_${devId}_${gId}` }];
            });
            if (guests.length > 1) {
                buttons.push([{ text: `🚨 Eliminar TODOS los Familiares`, callback_data: `/delallguests_${devId}` }]);
            }
            buttons.push([{ text: `🔙 Volver`, callback_data: '/invitar' }]);
            await sendTelegramMessage(chatId, listMsg, buttons);

        } else if (text.startsWith('/delguest_')) {
            const parts = text.replace('/delguest_', '').split('_');
            const devId = (parts[0] || '').toUpperCase().trim();
            const targetGuestId = (parts[1] || '').trim();
            const dev = getDevice(devId);

            if (!checkIsOwner(dev, chatId, true)) {
                await sendTelegramMessage(chatId, `⛔ <b>Acceso Denegado:</b> Solo el Propietario puede eliminar familiares.`, []);
                return new Response('OK', { status: 200 });
            }

            if (dev && targetGuestId) {
                const gName = getGuestName(dev, targetGuestId) || 'Familiar';
                await env.DB.prepare("DELETE FROM guests WHERE device_id = ? AND guest_chat_id = ?").bind(devId, targetGuestId).run();
                await env.DB.prepare("UPDATE devices SET updated_at = ? WHERE device_id = ?").bind(Date.now(), devId).run();

                await sendTelegramMessage(chatId,
                    `✅ <b>Familiar eliminado con éxito:</b>\n\n` +
                    `👤 <b>Nombre:</b> <b>${gName}</b>\n` +
                    `👥 <b>Chat ID:</b> <code>${targetGuestId}</code>\n` +
                    `📍 <b>Monitor:</b> <b>${dev.alias || devId}</b> (<code>${devId}</code>)\n\n` +
                    `Este familiar ya no recibirá alertas de luz ni tendrá acceso al monitor.`,
                    [
                        [{ text: '👥 Gestión de Familiares', callback_data: '/invitar' }],
                        [{ text: '🏠 Mis Monitores', callback_data: '/casas' }]
                    ]
                );

                sendTelegramMessage(targetGuestId,
                    `ℹ️ <b>Notificación:</b> Has sido removido como familiar del monitor <b>${dev.alias || devId}</b>.`,
                    []
                ).catch(() => {});
            }

        } else if (text.startsWith('/delallguests_')) {
            const devId = text.replace('/delallguests_', '').toUpperCase().trim();
            const dev = getDevice(devId);

            if (!checkIsOwner(dev, chatId, true)) {
                await sendTelegramMessage(chatId, `⛔ <b>Acceso Denegado:</b> Solo el Propietario puede eliminar familiares.`, []);
                return new Response('OK', { status: 200 });
            }

            if (dev) {
                const prevCount = (dev.guestChatIds || []).length;
                await env.DB.prepare("DELETE FROM guests WHERE device_id = ?").bind(devId).run();
                await env.DB.prepare("UPDATE devices SET updated_at = ? WHERE device_id = ?").bind(Date.now(), devId).run();

                await sendTelegramMessage(chatId,
                    `✅ <b>Todos los familiares de <code>${dev.alias || devId}</code> han sido eliminados.</b>\n\n` +
                    `Se eliminaron ${prevCount} familiar(es) registrado(s).`,
                    [
                        [{ text: '👥 Gestión de Familiares', callback_data: '/invitar' }],
                        [{ text: '🏠 Mis Monitores', callback_data: '/casas' }]
                    ]
                );
            }

        } else if (text.startsWith('/editguest_')) {
            const devId = text.replace('/editguest_', '').toUpperCase().trim();
            const dev = getDevice(devId);

            if (!checkIsOwner(dev, chatId, true)) {
                await sendTelegramMessage(chatId, `⛔ <b>Acceso Denegado:</b> Solo el Propietario puede gestionar familiares.`, []);
                return new Response('OK', { status: 200 });
            }

            const guests = dev?.guestChatIds || [];
            if (guests.length === 0) {
                await sendTelegramMessage(chatId, `ℹ️ El monitor <b>${dev?.alias || devId}</b> no tiene familiares registrados.`, []);
                return new Response('OK', { status: 200 });
            }

            let listMsg = `✏️ <b>CAMBIAR NOMBRE DE FAMILIAR</b>\n\n📍 <b>Monitor:</b> <b>${dev?.alias || devId}</b>\n\nSelecciona el familiar al que deseas cambiarle el nombre:`;
            const buttons = guests.map(gId => {
                const gName = getGuestName(dev, gId) || `Chat ID ${gId}`;
                return [{ text: `✏️ Modificar: ${gName}`, callback_data: `/renameguest_${devId}_${gId}` }];
            });
            buttons.push([{ text: `🔙 Volver`, callback_data: '/invitar' }]);
            await sendTelegramMessage(chatId, listMsg, buttons);

        } else if (text.startsWith('/renameguest_')) {
            const parts = text.replace('/renameguest_', '').split('_');
            const devId = (parts[0] || '').toUpperCase().trim();
            const targetGuestId = (parts[1] || '').trim();
            const dev = getDevice(devId);

            if (!checkIsOwner(dev, chatId, true)) {
                await sendTelegramMessage(chatId, `⛔ <b>Acceso Denegado:</b> Solo el Propietario puede gestionar familiares.`, []);
                return new Response('OK', { status: 200 });
            }

            const currentName = getGuestName(dev, targetGuestId) || 'Sin nombre';
            const state = { action: 'SET_GUEST_NAME', devId: devId, guestChatId: targetGuestId };
            await env.DB.prepare("INSERT OR REPLACE INTO pending_states (chat_id, state_json, updated_at) VALUES (?, ?, ?)").bind(chatId, JSON.stringify(state), Date.now()).run();

            await sendTelegramMessage(chatId,
                `✏️ <b>Modificar Nombre de Familiar</b>\n\n` +
                `📍 <b>Monitor:</b> <b>${dev?.alias || devId}</b>\n` +
                `👥 <b>Chat ID:</b> <code>${targetGuestId}</code>\n` +
                `👤 <b>Nombre actual:</b> <b>${currentName}</b>\n\n` +
                `👉 Por favor, <b>escribe el nuevo nombre o parentesco</b> para esta persona (ej: <i>Mamá</i>, <i>Hermano</i>, <i>Carlos</i>):`,
                [[{ text: '❌ Cancelar', callback_data: '/invitar' }]]
            );

        } else if (text.startsWith('/pedirnombre_')) {
            const devId = text.replace('/pedirnombre_', '').toUpperCase().trim();
            const dev = getDevice(devId);

            if (!checkIsOwner(dev, chatId, true)) {
                await sendTelegramMessage(chatId, `⛔ <b>Acceso Denegado:</b> Solo el Propietario puede renombrar este monitor.`, []);
                return new Response('OK', { status: 200 });
            }

            const state = { action: 'RENAME_MONITOR', devId: devId };
            await env.DB.prepare("INSERT OR REPLACE INTO pending_states (chat_id, state_json, updated_at) VALUES (?, ?, ?)").bind(chatId, JSON.stringify(state), Date.now()).run();

            await sendTelegramMessage(chatId,
                `✏️ <b>Renombrando:</b> <code>${dev.alias || devId}</code> (<code>${devId}</code>)\n\n👉 Escribe el nuevo nombre (ej: <i>Casa Maracay</i>):`,
                [[{ text: '❌ Cancelar', callback_data: '/casas' }]]
            );

        } else if (text.startsWith('/estado_')) {
            const devId = text.replace('/estado_', '').toUpperCase().trim();
            const dev = getDevice(devId);
            const isOwn = checkIsOwner(dev, chatId, true);
            const statusBtns = [
                [{ text: '🏠 Mis Monitores', callback_data: '/casas' }],
                [{ text: '📜 Ver Historial', callback_data: `/historial_${devId}` }]
            ];
            if (isOwn) {
                if (!dev?.locationLocked) {
                    statusBtns.push([{ text: '📍 Fijar Ubicación GPS', callback_data: `/ubicar_${devId}` }]);
                }
                statusBtns.push([{ text: '✏️ Editar Dirección Escrita', callback_data: `/direccion_${devId}` }]);
            }
            if (chatId === '330749449' && dev?.locationLocked) {
                statusBtns.push([{ text: '🔓 Desbloquear Ubicación (Admin)', callback_data: `/desbloquear_ubicar_${devId}` }]);
            }
            await sendTelegramMessage(chatId, buildStatusMsg(dev, devId, chatId), statusBtns);

        } else if (text.startsWith('/direccion_')) {
            const devId = text.replace('/direccion_', '').toUpperCase().replace(/_/g, '-').trim();
            const dev = getDevice(devId) || await getDeviceFast(env.DB, devId);

            if (!checkIsOwner(dev, chatId, true)) {
                await sendTelegramMessage(chatId, `⛔ <b>Acceso Denegado:</b> Solo el Propietario o Administrador puede modificar la dirección de este monitor.`, []);
                return new Response('OK', { status: 200 });
            }

            const state = { action: 'SET_ADDRESS', devId: devId };
            await env.DB.prepare("INSERT OR REPLACE INTO pending_states (chat_id, state_json, updated_at) VALUES (?, ?, ?)").bind(chatId, JSON.stringify(state), Date.now()).run();

            await sendTelegramMessage(chatId,
                `✏️ <b>Modificar Dirección de Monitor</b>\n\n` +
                `🏠 <b>Monitor:</b> <b>${dev?.alias || devId}</b> (<code>${devId}</code>)\n` +
                `🗺️ <b>Dirección actual:</b>\n<i>${dev?.address || 'Sin dirección registrada'}</i>\n\n` +
                `👉 Por favor, escribe la dirección exacta o punto de referencia que deseas que aparezca (ej: <i>Urb. Andrés Bello, Av. Las Delicias, Maracay</i>):`,
                [[{ text: '❌ Cancelar', callback_data: `/estado_${devId}` }]]
            );
            return new Response('OK', { status: 200 });

        } else if (text.startsWith('/desbloquear_ubicar_')) {
            if (chatId !== '330749449') {
                await sendTelegramMessage(chatId, `⛔ <b>Acceso Denegado:</b> Solo el Administrador puede desbloquear la ubicación.`);
                return new Response('OK', { status: 200 });
            }
            const devId = text.replace('/desbloquear_ubicar_', '').toUpperCase().replace(/_/g, '-').trim();
            const dev = getDevice(devId) || await getDeviceFast(env.DB, devId);
            if (!dev) {
                await sendTelegramMessage(chatId, `⚠️ Dispositivo no encontrado: <code>${devId}</code>`);
                return new Response('OK', { status: 200 });
            }
            await env.DB.prepare("UPDATE devices SET location_locked = 0, updated_at = ? WHERE device_id = ?").bind(Date.now(), devId).run();
            await sendTelegramMessage(chatId,
                `🔓 <b>Ubicación desbloqueada con éxito</b> para el monitor <b>${dev.alias || devId}</b> (<code>${devId}</code>).\n\nEl usuario ahora puede volver a usar el botón 📍 Fijar Ubicación GPS para re-calibrar su posición si se mudó.`,
                [
                    [{ text: '📍 Fijar Ubicación Ahora', callback_data: `/ubicar_${devId}` }],
                    [{ text: '👑 Panel de Administración', callback_data: '/admin' }]
                ]
            );
            return new Response('OK', { status: 200 });

        } else if (text.startsWith('/ubicar_')) {
            const devId = text.replace('/ubicar_', '').toUpperCase().trim();
            const dev = getDevice(devId);

            if (!checkIsOwner(dev, chatId, true)) {
                await sendTelegramMessage(chatId, `⛔ <b>Acceso Denegado:</b> Solo el Propietario (Titular) puede calibrar la ubicación de este monitor.`, []);
                return new Response('OK', { status: 200 });
            }

            if (dev?.locationLocked) {
                const adminUnlockBtn = (chatId === '330749449') ? [[{ text: '🔓 Desbloquear (Admin)', callback_data: `/desbloquear_ubicar_${devId}` }]] : [];
                await sendTelegramMessage(chatId,
                    `🔒 <b>Ubicación ya fijada y protegida</b>\n\n` +
                    `📍 <b>Monitor:</b> <b>${dev.alias || devId}</b> (<code>${devId}</code>)\n` +
                    `🗺️ <b>Dirección actual:</b>\n<i>${dev.address || `${dev.latitude}, ${dev.longitude}`}</i>\n\n` +
                    `Por seguridad, esta función quedó bloqueada permanentemente para evitar que se desconfigure si te conectas fuera de tu casa (playa, viajes o trabajo).\n\n` +
                    `<i>Si te mudaste de casa o necesitas re-calibrar, pide al administrador que desbloquee tu monitor.</i>`,
                    [
                        ...adminUnlockBtn,
                        [{ text: '🏠 Mis Monitores', callback_data: '/casas' }]
                    ]
                );
                return new Response('OK', { status: 200 });
            }

            const state = { action: 'SET_LOCATION', devId: devId };
            await env.DB.prepare("INSERT OR REPLACE INTO pending_states (chat_id, state_json, updated_at) VALUES (?, ?, ?)").bind(chatId, JSON.stringify(state), Date.now()).run();

            await sendTelegramReplyKeyboard(chatId,
                `📍 <b>FIJAR UBICACIÓN EXACTA DE TU CASA</b>\n\n` +
                `🏠 <b>Monitor:</b> <b>${dev?.alias || devId}</b> (<code>${devId}</code>)\n\n` +
                `⚠️ <b>IMPORTANTE:</b>\n` +
                `1. Realiza este paso <b>estando físicamente en tu casa</b> (conectado al WiFi de tu casa o con el GPS encendido en tu móvil).\n` +
                `2. Una vez guardada, la ubicación <b>quedará bloqueada automáticamente</b> para que nunca se altere cuando salgas de casa.\n\n` +
                `👇 Presiona el botón rojo de abajo para enviar tu ubicación actual:`,
                [
                    [{ text: "📍 Enviar Mi Ubicación Actual", request_location: true }],
                    [{ text: "❌ Cancelar" }]
                ]
            );
            return new Response('OK', { status: 200 });

        } else if (text.includes('/ubicar') || text.includes('ubicar') || text.includes('localizacion') || text.includes('ubicacion')) {
            const myDevs = devs.filter(d => checkIsOwner(d, chatId, true));
            if (myDevs.length === 0) {
                await sendTelegramMessage(chatId, `⚠️ No tienes monitores vinculados como propietario en tu Chat ID (<code>${chatId}</code>).`, []);
            } else if (myDevs.length === 1) {
                const d = myDevs[0];
                if (d.locationLocked) {
                    const adminUnlockBtn = (chatId === '330749449') ? [[{ text: '🔓 Desbloquear (Admin)', callback_data: `/desbloquear_ubicar_${d.deviceId}` }]] : [];
                    await sendTelegramMessage(chatId,
                        `🔒 <b>Ubicación ya fijada y protegida</b>\n\n` +
                        `📍 <b>Monitor:</b> <b>${d.alias || d.deviceId}</b>\n` +
                        `🗺️ <b>Dirección actual:</b>\n<i>${d.address || `${d.latitude}, ${d.longitude}`}</i>\n\n` +
                        `Por seguridad, esta opción se deshabilitó tras fijarla una vez para proteger tu sistema contra ubicaciones erróneas cuando salgas de casa.`,
                        [
                            ...adminUnlockBtn,
                            [{ text: '🏠 Mis Monitores', callback_data: '/casas' }]
                        ]
                    );
                } else {
                    const state = { action: 'SET_LOCATION', devId: d.deviceId };
                    await env.DB.prepare("INSERT OR REPLACE INTO pending_states (chat_id, state_json, updated_at) VALUES (?, ?, ?)").bind(chatId, JSON.stringify(state), Date.now()).run();
                    await sendTelegramReplyKeyboard(chatId,
                        `📍 <b>FIJAR UBICACIÓN EXACTA DE TU CASA</b>\n\n` +
                        `🏠 <b>Monitor:</b> <b>${d.alias || d.deviceId}</b> (<code>${d.deviceId}</code>)\n\n` +
                        `⚠️ <b>IMPORTANTE:</b>\n` +
                        `1. Realiza este paso <b>estando físicamente en tu casa</b> (conectado al WiFi de tu casa o con el GPS encendido en tu móvil).\n` +
                        `2. Una vez guardada, la ubicación <b>quedará bloqueada automáticamente</b> para que nunca se altere cuando viajes o estés fuera de casa.\n\n` +
                        `👇 Presiona el botón rojo de abajo para enviar tu ubicación actual:`,
                        [
                            [{ text: "📍 Enviar Mi Ubicación Actual", request_location: true }],
                            [{ text: "❌ Cancelar" }]
                        ]
                    );
                }
            } else {
                let txt = `📍 <b>FIJAR UBICACIÓN DE TU CASA</b>\n\n¿A cuál de tus monitores deseas fijarle la ubicación GPS?\n\n`;
                const btns = [];
                myDevs.forEach(d => {
                    const lockStatus = d.locationLocked ? '🔒 [Fijada]' : '📍 [Pendiente]';
                    txt += `• <b>${d.alias || d.deviceId}</b> ${lockStatus}\n`;
                    btns.push([{ text: `📍 Calibrar ${d.alias || d.deviceId} ${lockStatus}`, callback_data: `/ubicar_${d.deviceId}` }]);
                });
                btns.push([{ text: '🔙 Volver a Mis Monitores', callback_data: '/casas' }]);
                await sendTelegramMessage(chatId, txt, btns);
            }

        } else if (text.includes('/estado') || text.includes('estado')) {
            const now = Date.now();
            const myDevs = getMyDevs();
            if (myDevs.length === 0) {
                await sendTelegramMessage(chatId, `⚠️ <b>Dispositivo no vinculado.</b>\n\nTu Chat ID: <code>${chatId}</code>. Ingrésalo al configurar la placa.`, []);
            } else if (myDevs.length > 1) {
                await sendTelegramMessage(chatId, `🏠 <b>¿Cuál monitor deseas consultar?</b>`,
                    myDevs.map(d => {
                        const on = (now - d.lastSeen) < OFFLINE_THRESHOLD_MS;
                        const isOwn = checkIsOwner(d, chatId);
                        const roleTag = isOwn ? '👑 Propietario' : '👤 Invitado';
                        return [{ text: `${on ? '🟢' : '🔴'} ${d.alias || d.deviceId} [${roleTag}]`, callback_data: `/estado_${d.deviceId}` }];
                    })
                );
            } else {
                await sendTelegramMessage(chatId, buildStatusMsg(myDevs[0], myDevs[0].deviceId, chatId), [
                    [{ text: '🏠 Mis Monitores', callback_data: '/casas' }],
                    [{ text: '📜 Ver Historial', callback_data: '/historial' }]
                ]);
            }

        } else if (text.includes('/casas') || text.includes('/dispositivos') || text.includes('mis casas') || text.includes('monitores')) {
            const now = Date.now();
            const myDevs = getMyDevs();
            if (myDevs.length === 0) {
                await sendTelegramMessage(chatId, `⚠️ No tienes monitores vinculados a tu Chat ID (<code>${chatId}</code>).`, []);
            } else {
                let txt = `🏠 <b>TUS MONITORES (${myDevs.length}):</b>\n\n`;
                const btns = [];
                myDevs.forEach(d => {
                    const on = (now - d.lastSeen) < OFFLINE_THRESHOLD_MS;
                    const isOwn = checkIsOwner(d, chatId);
                    const roleTag = isOwn ? '👑 Propietario' : '👤 Invitado';
                    const geoSuffix = (d.city && d.isp) ? ` <i>(${d.city} — ${d.isp})</i>` : '';
                    txt += `• <b>${d.alias || d.deviceId}</b> [${roleTag}]${geoSuffix}: ${on ? '🟢 HAY LUZ' : '🔴 SIN LUZ'}\n`;
                    btns.push([{ text: `📍 ${d.alias || d.deviceId} [${roleTag}]`, callback_data: `/estado_${d.deviceId}` }]);
                });
                btns.push([{ text: '✏️ Cambiar Nombre', callback_data: '/renombrar' }]);
                btns.push([{ text: '👥 Gestionar Familiares', callback_data: '/invitar' }]);
                btns.push([{ text: '📍 Fijar Ubicación GPS', callback_data: '/ubicar' }]);
                if (chatId === '330749449') {
                    btns.push([{ text: '👑 Panel de Administración', callback_data: '/admin' }]);
                }
                await sendTelegramMessage(chatId, txt, btns);
            }

        } else if (text.startsWith('/historial_')) {
            const devId = text.replace('/historial_', '').toUpperCase().trim();
            const dev = getDevice(devId);
            await sendTelegramMessage(chatId,
                dev ? buildHistoryMsg(dev, chatId) : `⚠️ No encontré el dispositivo <code>${devId}</code>.`,
                [[{ text: '📊 Estado en Vivo', callback_data: `/estado_${devId}` }],
                 [{ text: '🏠 Mis Monitores', callback_data: '/casas' }]]
            );

        } else if (text.includes('/historial') || text.includes('historial') || text.includes('cortes')) {
            const myDevs = getMyDevs();
            if (myDevs.length === 0) {
                await sendTelegramMessage(chatId, `⚠️ No tienes monitores vinculados a tu Chat ID (<code>${chatId}</code>).`, []);
            } else if (myDevs.length > 1) {
                await sendTelegramMessage(chatId, `📜 <b>¿De cuál monitor deseas ver el historial de cortes?</b>`,
                    myDevs.map(d => {
                        const isOwn = checkIsOwner(d, chatId);
                        const roleTag = isOwn ? '👑 Propietario' : '👤 Invitado';
                        return [{ text: `📜 ${d.alias || d.deviceId} [${roleTag}]`, callback_data: `/historial_${d.deviceId}` }];
                    })
                );
            } else {
                await sendTelegramMessage(chatId, buildHistoryMsg(myDevs[0], chatId), [
                    [{ text: '📊 Estado en Vivo', callback_data: `/estado_${myDevs[0].deviceId}` }],
                    [{ text: '🏠 Mis Monitores', callback_data: '/casas' }]
                ]);
            }

        } else if (text.startsWith('/reporte_')) {
            const devId = text.replace('/reporte_', '').toUpperCase().trim();
            const dev = getDevice(devId);
            await sendTelegramMessage(chatId,
                dev ? (buildWeeklyReport(dev, chatId) || '⚠️ Sin datos suficientes.') : `⚠️ No encontré el dispositivo <code>${devId}</code>.`,
                [[{ text: '📊 Estado en Vivo', callback_data: `/estado_${devId}` }],
                 [{ text: '🏠 Mis Monitores', callback_data: '/casas' }]]
            );

        } else if (text.includes('/reporte') || text.includes('reporte') || text.includes('semanal')) {
            const myDevs = getMyDevs();
            if (myDevs.length === 0) {
                await sendTelegramMessage(chatId, `⚠️ No tienes monitores vinculados a tu Chat ID (<code>${chatId}</code>).`, []);
            } else if (myDevs.length > 1) {
                await sendTelegramMessage(chatId, `📈 <b>¿De cuál monitor deseas generar el reporte semanal?</b>`,
                    myDevs.map(d => {
                        const isOwn = checkIsOwner(d, chatId);
                        const roleTag = isOwn ? '👑 Propietario' : '👤 Invitado';
                        return [{ text: `📈 ${d.alias || d.deviceId} [${roleTag}]`, callback_data: `/reporte_${d.deviceId}` }];
                    })
                );
            } else {
                await sendTelegramMessage(chatId, buildWeeklyReport(myDevs[0], chatId) || '⚠️ Sin datos suficientes.', [
                    [{ text: '📊 Estado en Vivo', callback_data: `/estado_${myDevs[0].deviceId}` }],
                    [{ text: '🏠 Mis Monitores', callback_data: '/casas' }]
                ]);
            }

        } else if (text.includes('/nombre') || text.includes('/renombrar') || text.includes('renombrar') || text.includes('asignar')) {
            const myDevs = devs.filter(d => checkIsOwner(d, chatId, true));
            if (myDevs.length === 0) {
                await sendTelegramMessage(chatId, `⚠️ No tienes dispositivos como propietario administrador vinculados a tu Chat ID (<code>${chatId}</code>).`, []);
            } else {
                let txt = `🏷️ <b>¿A cuál monitor le cambias el nombre?</b>\n\n`;
                const btns = [];
                myDevs.forEach(d => {
                    txt += `• <b>${d.alias || d.deviceId}</b>\n`;
                    btns.push([{ text: `✏️ Renombrar ${d.alias || d.deviceId}`, callback_data: `/pedirnombre_${d.deviceId}` }]);
                });
                await sendTelegramMessage(chatId, txt, btns);
            }

        } else if (text.includes('/invitar') || text.includes('invitar') || text.includes('familiar') || text.includes('invitado')) {
            const myDevs = devs.filter(d => checkIsOwner(d, chatId, true));
            if (myDevs.length === 0) {
                await sendTelegramMessage(chatId, `⚠️ Solo el propietario administrador puede agregar o gestionar familiares en el monitor.`, []);
            } else {
                let txt = `👥 <b>GESTIÓN DE FAMILIARES E INVITADOS</b>\n\n`;
                const btns = [];
                myDevs.forEach(d => {
                    const guests = d.guestChatIds || [];
                    const n = guests.length;
                    const devName = d.alias || d.deviceId;
                    txt += `📍 <b>${devName}</b> (<code>${d.deviceId}</code>) — ${n} familiar(es):\n`;
                    if (n === 0) {
                        txt += `   <i>(Sin familiares registrados)</i>\n`;
                    } else {
                        guests.forEach((gId, idx) => {
                            const gName = getGuestName(d, gId) || `Familiar ${idx + 1}`;
                            txt += `   • <b>${gName}</b> (<code>${gId}</code>)\n`;
                        });
                    }
                    txt += `\n`;
                    btns.push([{ text: `➕ Agregar a ${devName}`, callback_data: `/pedirinvitado_${d.deviceId}` }]);
                    if (n > 0) {
                        btns.push([
                            { text: `✏️ Modificar Nombre en ${devName}`, callback_data: `/editguest_${d.deviceId}` },
                            { text: `❌ Quitar Familiar en ${devName}`, callback_data: `/quitarinvitado_${d.deviceId}` }
                        ]);
                    }
                });
                btns.push([{ text: '🏠 Mis Monitores', callback_data: '/casas' }]);
                await sendTelegramMessage(chatId, txt, btns);
            }

        } else if (text.startsWith('/confirm_reset_step1_')) {
            const devId = text.replace('/confirm_reset_step1_', '').toUpperCase().trim();
            const myDev = devs.find(d => checkIsOwner(d, chatId, true) && d.deviceId.toUpperCase() === devId);
            if (!myDev) {
                await sendTelegramMessage(chatId, `⚠️ <b>Acceso Denegado o monitor no encontrado.</b> Solo el propietario puede reiniciar la placa.`, []);
            } else {
                const devName = myDev.alias || myDev.deviceId;
                await sendTelegramMessage(chatId,
                    `🚨 <b>¡ALERTA DE DESCONFIGURACIÓN!</b> 🚨\n\n` +
                    `⚠️ <b>Si continúas con esta acción:</b>\n` +
                    `• La placa <b>${devName}</b> (<code>${myDev.deviceId}</code>) <b>borrará la clave WiFi actual</b>.\n` +
                    `• El monitor se desconfigurará y <b>dejará de enviar alertas de luz</b>.\n` +
                    `• Emitirá su propia red WiFi (<code>Configurar-Luz</code>) para que te conectes desde tu celular y la vuelvas a configurar.\n\n` +
                    `¿Está totalmente seguro de proceder?`,
                    [
                        [{ text: "🔄 Sí, Desconfigurar y Reiniciar", callback_data: `/confirm_reset_final_${myDev.deviceId}` }],
                        [{ text: "❌ No, Cancelar", callback_data: "/casas" }]
                    ]
                );
            }

        } else if (text.startsWith('/confirm_reset_final_')) {
            const devId = text.replace('/confirm_reset_final_', '').toUpperCase().trim();
            const myDev = devs.find(d => checkIsOwner(d, chatId, true) && d.deviceId.toUpperCase() === devId);
            if (!myDev) {
                await sendTelegramMessage(chatId, `⚠️ <b>Acceso Denegado.</b> Solo el administrador propietario puede reiniciar la placa.`, []);
            } else {
                await env.DB.prepare("UPDATE devices SET reset_requested = 1, updated_at = ? WHERE device_id = ?").bind(Date.now(), devId).run();
                await sendTelegramMessage(chatId,
                    `✅ <b>¡Orden de reinicio enviada a la placa!</b>\n\n` +
                    `📱 <b>Dispositivo:</b> <code>${myDev.deviceId}</code>\n\n` +
                    `En su próximo reporte (máximo 60 segundos), la placa borrará su memoria WiFi y activará la red <code>Configurar-Luz</code>.`,
                    [[{ text: "📊 Ver Estado", callback_data: `/estado_${myDev.deviceId}` }]]
                );
            }

        } else if (text.includes('/reiniciar') || text.includes('reiniciar')) {
            const myDevs = devs.filter(d => checkIsOwner(d, chatId, true));
            if (myDevs.length === 0) {
                await sendTelegramMessage(chatId, `⚠️ <b>Acceso Denegado.</b> Solo el administrador propietario puede reiniciar la placa.`, []);
            } else {
                const myDev = myDevs[0];
                const devName = myDev.alias || myDev.deviceId;
                await sendTelegramMessage(chatId,
                    `⚠️ <b>¿Está seguro de que desea reiniciar la placa?</b>\n\n` +
                    `📍 <b>Monitor:</b> <b>${devName}</b> (<code>${myDev.deviceId}</code>)\n\n` +
                    `Esta acción iniciará el proceso de reinicio WiFi del equipo.`,
                    [
                        [{ text: "⚠️ Sí, deseo continuar", callback_data: `/confirm_reset_step1_${myDev.deviceId}` }],
                        [{ text: "❌ Cancelar", callback_data: "/casas" }]
                    ]
                );
            }

        } else if (text.includes('/chatid') || text.includes('chatid') || text.includes('mi id')) {
            await sendTelegramMessage(chatId, `<code>${chatId}</code>`, [
                [{ text: '📊 Estado en Vivo', callback_data: '/estado' }],
                [{ text: '🏠 Mis Monitores', callback_data: '/casas' }]
            ]);

        } else if (text === '/admin' || text.includes('/admin') || text.includes('administracion') || text.includes('administrador')) {
            if (chatId !== '330749449') {
                await sendTelegramMessage(chatId, `⛔ <b>Acceso Denegado:</b> Este panel es exclusivo para el Super Administrador del sistema.`, [
                    [{ text: '📊 Estado en Vivo', callback_data: '/estado' }]
                ]);
                return new Response('OK', { status: 200 });
            }

            const allDevs = devs.filter(d => !d.unlinked && d.deviceId);
            const now = Date.now();
            let onlineCount = 0;
            let offlineCount = 0;

            let reportMsg = `👑 <b>PANEL DE ADMINISTRACIÓN GLOBAL</b>\n`;
            reportMsg += `<i>Control Central de Monitores de Luz</i>\n`;
            reportMsg += `══════════════════════════\n\n`;

            allDevs.forEach((d, idx) => {
                const isOnline = (now - (d.lastSeen || 0)) < OFFLINE_THRESHOLD_MS;
                if (isOnline) onlineCount++; else offlineCount++;

                const statusIcon = isOnline ? '🟢' : '🔴';
                const statusText = isOnline ? 'CON LUZ' : 'SIN LUZ';
                const elapsedSec = Math.max(0, Math.round((now - (d.lastSeen || 0)) / 1000));
                let elapsedStr = `${elapsedSec}s`;
                if (elapsedSec >= 60 && elapsedSec < 3600) {
                    elapsedStr = `${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s`;
                } else if (elapsedSec >= 3600) {
                    elapsedStr = `${Math.floor(elapsedSec / 3600)}h ${Math.floor((elapsedSec % 3600) / 60)}m`;
                }

                const aliasName = d.alias || d.deviceId;
                const ispInfo = d.isp ? d.isp : 'Desconocido';
                const cityInfo = d.city ? `${d.city}${d.region ? ', ' + d.region : ''}` : '';
                const ownerInfo = d.chatId ? `<code>${d.chatId}</code>` : 'Sin asignar';
                const uptimeMs = isOnline ? Math.max(0, now - (d.onlineSince || d.lastSeen || now)) : 0;
                const uptimeMins = Math.round(uptimeMs / 60000);
                let uptimeStr = `${uptimeMins}m`;
                if (uptimeMins >= 60 && uptimeMins < 1440) {
                    uptimeStr = `${Math.floor(uptimeMins / 60)}h ${uptimeMins % 60}m`;
                } else if (uptimeMins >= 1440) {
                    const days = Math.floor(uptimeMins / 1440);
                    const hours = Math.floor((uptimeMins % 1440) / 60);
                    uptimeStr = `${days}d ${hours}h`;
                }

                reportMsg += `${idx + 1}. ${statusIcon} <b>${aliasName}</b> (<code>${d.deviceId}</code>)\n`;
                reportMsg += `   • Estado: <b>${statusText}</b> (hace ${elapsedStr})\n`;
                if (cityInfo) reportMsg += `   • Ubicación: ${cityInfo}\n`;
                if (d.address) {
                    reportMsg += `   • GPS: ${d.address} ${d.locationLocked ? '🔒' : '🔓'}\n`;
                    if (d.locationLocked) {
                        reportMsg += `   • 🔓 <b>Desbloquear GPS:</b> /desbloquear_ubicar_${d.deviceId.replace(/-/g, '_')}\n`;
                    }
                }
                reportMsg += `   • ✏️ <b>Editar Dirección:</b> /direccion_${d.deviceId.replace(/-/g, '_')}\n`;
                reportMsg += `   • Red: ${ispInfo} | IP: <code>${d.ip || '0.0.0.0'}</code>\n`;
                reportMsg += `   • 🚨 <b>Reset de Fábrica:</b> /reset_${d.deviceId.replace(/-/g, '_')}\n`;
                reportMsg += `   • Tiempo con luz: ${uptimeStr}\n`;
                reportMsg += `   • Titular: ${ownerInfo}\n\n`;
            });

            reportMsg += `══════════════════════════\n`;
            reportMsg += `📊 <b>Total:</b> ${allDevs.length} monitores | 🟢 <b>${onlineCount} Online</b> | 🔴 <b>${offlineCount} Offline</b>`;

            const adminButtons = [
                [{ text: '👥 Gestionar Familiares', callback_data: '/invitar' }],
                [{ text: '🔄 Actualizar Panel Admin', callback_data: '/admin' }],
                [{ text: '🏠 Menú Principal', callback_data: '/start' }]
            ];

            await sendTelegramMessage(chatId, reportMsg, adminButtons);
            return new Response('OK', { status: 200 });

        } else if (text === '/admin_wipe_list' || text.includes('autodestruccion')) {
            if (chatId !== '330749449') {
                await sendTelegramMessage(chatId, `⛔ <b>Acceso Denegado:</b> Solo el Super Administrador puede acceder a esta función.`);
                return new Response('OK', { status: 200 });
            }

            const activeDevs = devs.filter(d => !d.unlinked && d.deviceId);
            if (activeDevs.length === 0) {
                await sendTelegramMessage(chatId, `ℹ️ No hay monitores activos disponibles para restablecer.`, [
                    [{ text: '👑 Volver al Panel Admin', callback_data: '/admin' }]
                ]);
                return new Response('OK', { status: 200 });
            }

            let wipeMsg = `🚨 <b>SELECCIONA LA PLACA A RESTABLECER A CERO:</b>\n\n`;
            wipeMsg += `Elige la placa devuelta que deseas desvincular y borrar de fábrica:\n`;

            const wipeButtons = activeDevs.map(d => {
                const name = d.alias || d.deviceId;
                return [{ text: `🔴 Restablecer: ${name}`, callback_data: `/admin_wipe_step1_${d.deviceId}` }];
            });
            wipeButtons.push([{ text: '🔙 Cancelar y Volver', callback_data: '/admin' }]);

            await sendTelegramMessage(chatId, wipeMsg, wipeButtons);
            return new Response('OK', { status: 200 });

        } else if (text.startsWith('/admin_wipe_step1_') || text.startsWith('/reset_')) {
            if (chatId !== '330749449') {
                await sendTelegramMessage(chatId, `⛔ <b>Acceso Denegado.</b>`);
                return new Response('OK', { status: 200 });
            }

            let rawId = text.startsWith('/admin_wipe_step1_') 
                ? text.replace('/admin_wipe_step1_', '') 
                : text.replace('/reset_', '');
            const devId = rawId.toUpperCase().replace(/_/g, '-').trim();
            const targetDev = await getDeviceFast(env.DB, devId);
            const devName = targetDev?.alias || devId;

            let warnMsg1 = `⚠️ <b>ADVERTENCIA DE SEGURIDAD (Confirmación 1 de 2)</b> ⚠️\n\n`;
            warnMsg1 += `¿Estás seguro de que deseas iniciar el proceso de <b>AUTODESTRUCCIÓN Y RESET</b> para:\n\n`;
            warnMsg1 += `📍 <b>${devName}</b> (<code>${devId}</code>)?\n\n`;
            warnMsg1 += `📋 <b>Lo que va a suceder:</b>\n`;
            warnMsg1 += `• La placa se <b>desvinculará por completo</b> del titular actual y de todos sus familiares.\n`;
            warnMsg1 += `• En su próximo reporte (máximo 45 segundos), la placa <b>borrará su memoria WiFi física</b>.\n`;
            warnMsg1 += `• Volverá a emitir su red original <code>Configurar-Luz</code> en <code>192.168.4.1</code>.\n\n`;
            warnMsg1 += `¿Deseas continuar a la confirmación final?`;

            const warnButtons1 = [
                [{ text: '⚠️ SÍ, CONTINUAR CON EL RESET ⚠️', callback_data: `/admin_wipe_step2_${devId}` }],
                [{ text: '❌ No, Cancelar y Salir', callback_data: '/admin' }]
            ];

            await sendTelegramMessage(chatId, warnMsg1, warnButtons1);
            return new Response('OK', { status: 200 });

        } else if (text.startsWith('/admin_wipe_step2_')) {
            if (chatId !== '330749449') {
                await sendTelegramMessage(chatId, `⛔ <b>Acceso Denegado.</b>`);
                return new Response('OK', { status: 200 });
            }

            const devId = text.replace('/admin_wipe_step2_', '').toUpperCase().replace(/_/g, '-').trim();
            const targetDev = await getDeviceFast(env.DB, devId);
            const devName = targetDev?.alias || devId;

            let warnMsg2 = `🚨🚨 <b>CONFIRMACIÓN DEFINITIVA (Confirmación 2 de 2)</b> 🚨🚨\n\n`;
            warnMsg2 += `⛔ <b>ESTA ACCIÓN ES TOTALMENTE IRREVERSIBLE</b> ⛔\n\n`;
            warnMsg2 += `¿Confirmas que deseas <b>BORRAR DE FÁBRICA Y DESTRUIR LA CONFIGURACIÓN</b> de la placa:\n\n`;
            warnMsg2 += `💥 <b>${devName}</b> (<code>${devId}</code>)?\n\n`;
            warnMsg2 += `Al presionar el botón rojo de abajo:\n`;
            warnMsg2 += `• Se eliminará todo registro de usuarios y familiares en la nube.\n`;
            warnMsg2 += `• La placa física borrará sus claves y quedará virgen como salida de fábrica.\n`;
            warnMsg2 += `• Ningún usuario anterior podrá volver a ver este monitor.`;

            const warnButtons2 = [
                [{ text: '💥 SÍ, DESTRUIR Y BORRAR DE FÁBRICA AHORA 💥', callback_data: `/admin_wipe_exec_${devId}` }],
                [{ text: '❌ ABORTAR OPERACIÓN (MANTENER ACTIVA)', callback_data: '/admin' }]
            ];

            await sendTelegramMessage(chatId, warnMsg2, warnButtons2);
            return new Response('OK', { status: 200 });

        } else if (text.startsWith('/admin_wipe_exec_')) {
            if (chatId !== '330749449') {
                await sendTelegramMessage(chatId, `⛔ <b>Acceso Denegado.</b>`);
                return new Response('OK', { status: 200 });
            }

            const devId = text.replace('/admin_wipe_exec_', '').toUpperCase().replace(/_/g, '-').trim();
            const targetDev = await getDeviceFast(env.DB, devId);
            const oldAlias = targetDev?.alias || devId;

            // 1. Activar bandera de reset y desvinculación en Cloudflare D1
            await env.DB.prepare(
                "UPDATE devices SET reset_requested = 1, unlinked = 1, chat_id = '', alias = device_id, updated_at = ? WHERE device_id = ?"
            ).bind(Date.now(), devId).run();

            // 2. Eliminar familiares
            await env.DB.prepare("DELETE FROM guests WHERE device_id = ?").bind(devId).run();

            // 3. Eliminar estados pendientes
            await env.DB.prepare("DELETE FROM pending_states WHERE dev_id = ?").bind(devId).run();

            let successMsg = `✅ <b>¡ORDEN DE AUTODESTRUCCIÓN EJECUTADA CON ÉXITO!</b> 🧼\n\n`;
            successMsg += `📱 <b>Placa:</b> <code>${devId}</code> (<i>${oldAlias}</i>)\n\n`;
            successMsg += `• <b>Desvinculación:</b> Todos los usuarios y familiares fueron revocados en la nube.\n`;
            successMsg += `• <b>Señal física enviada:</b> En su próximo reporte (máximo 45 segundos), el chip borrará su memoria EEPROM interna.\n`;
            successMsg += `• <b>Resultado:</b> La placa volverá a emitir la red Wi-Fi <code>Configurar-Luz</code> y quedará 100% virgen como nueva de fábrica.`;

            const doneButtons = [
                [{ text: '👑 Volver al Panel de Administración', callback_data: '/admin' }]
            ];

            await sendTelegramMessage(chatId, successMsg, doneButtons);
            return new Response('OK', { status: 200 });

        } else if (text.includes('hola') || text.includes('/start') || text.includes('hello')) {
            const myDevs = getMyDevs();
            const startButtons = [];
            if (chatId === '330749449') {
                startButtons.push([{ text: '👑 Panel de Administración Global', callback_data: '/admin' }]);
            }
            startButtons.push([{ text: '📍 Ver Ubicaciones (Web App) 📱', web_app: { url: `https://monitor-luz-vercel-six.vercel.app/devices?chatId=${chatId}` } }]);
            startButtons.push([{ text: '📊 Estado en Vivo', callback_data: '/estado' }]);
            startButtons.push([{ text: '🆔 Ver mi Chat ID', callback_data: '/chatid' }]);
            startButtons.push([{ text: '✏️ Renombrar Casas', callback_data: '/renombrar' }]);
            startButtons.push([{ text: '👥 Gestionar Familiares', callback_data: '/invitar' }]);
            startButtons.push([{ text: '🏠 Mis Monitores', callback_data: '/casas' }]);
            startButtons.push([{ text: '📈 Reporte Semanal', callback_data: '/reporte' }]);
            startButtons.push([{ text: '📜 Historial de Cortes', callback_data: '/historial' }]);

            if (myDevs.length > 0) {
                const d = myDevs[0];
                const on = (Date.now() - d.lastSeen) < OFFLINE_THRESHOLD_MS;
                await sendTelegramMessage(chatId,
                    `⚡ <b>¡Hola ${senderName}! Bienvenido a Monitor de Luz</b>\n\n` +
                    `Tu monitor <b>${d.alias || d.deviceId}</b> está ${on ? '🟢 CON LUZ' : '🔴 SIN LUZ'}.\n\n¿Qué deseas hacer?`,
                    startButtons
                );
            } else {
                await sendTelegramMessage(chatId, `<code>${chatId}</code>`, [
                    ...(chatId === '330749449' ? [[{ text: '👑 Panel de Administración Global', callback_data: '/admin' }]] : []),
                    [{ text: '📊 Estado en Vivo', callback_data: '/estado' }]
                ]);
            }

        } else {
            const myDevs = getMyDevs();
            const queryNorm = text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
            const matchedDev = myDevs.find(d => {
                const aliasNorm = (d.alias || '').toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
                const devIdNorm = (d.deviceId || '').toLowerCase().trim();
                return (aliasNorm && (aliasNorm === queryNorm || queryNorm.includes(aliasNorm) || aliasNorm.includes(queryNorm))) ||
                       (devIdNorm && (devIdNorm === queryNorm || queryNorm.includes(devIdNorm)));
            });

            if (matchedDev) {
                await sendTelegramMessage(chatId, buildStatusMsg(matchedDev, matchedDev.deviceId, chatId), [
                    [{ text: '🏠 Mis Monitores', callback_data: '/casas' }],
                    [{ text: '📜 Ver Historial', callback_data: `/historial_${matchedDev.deviceId}` }]
                ]);
            } else {
                await sendTelegramMessage(chatId,
                    `💡 <i>Escribe <b>hola</b> para ver el menú, o usa los botones de abajo:</i>`,
                    [
                        [{ text: '📍 Ver Ubicaciones (Web App) 📱', web_app: { url: `https://monitor-luz-vercel-six.vercel.app/devices?chatId=${chatId}` } }],
                        [{ text: '📊 Estado en Vivo', callback_data: '/estado' }],
                        [{ text: '🆔 Ver mi Chat ID', callback_data: '/chatid' }],
                        [{ text: '🏠 Mis Monitores', callback_data: '/casas' }],
                        [{ text: '✏️ Renombrar', callback_data: '/renombrar' }]
                    ]
                );
            }
        }

    } catch (e) {
        console.error('[WEBHOOK ERROR]:', e.message);
    }

    return new Response('OK', { status: 200 });
}

// --- ENDPOINT POST /api/ping ---

async function handlePing(request, env) {
    let body = {};
    try { body = await request.json(); } catch(e) {}

    const deviceId = (body.deviceId || body.id || '').toString().trim().toUpperCase();
    if (!deviceId) return new Response(JSON.stringify({ error: 'Falta deviceId' }), { status: 400 });

    const boardUptimeMs = parseInt(body.uptimeMs || 0, 10);
    const chatId = (body.chatId || body.telegramChatId || '').toString().trim();
    const now = Date.now();
    const clientIp = getClientIp(request);
    const existing = await getDeviceFast(env.DB, deviceId);

    const shouldReset = existing ? existing.resetRequested : false;
    const wasBlackout = existing ? existing.blackoutNotified : false;
    let targetChatId = (existing && existing.chatId && !existing.unlinked) ? existing.chatId : (chatId || '');
    if (deviceId === 'ESP-7A562F') {
        targetChatId = '6754095244';
    }
    if (targetChatId === '3307499449') targetChatId = '330749449';

    let deviceAlias = existing?.alias || ((incomingAlias && incomingAlias !== deviceId) ? incomingAlias : deviceId);
    let isUnlinkedNow = existing ? existing.unlinked : false;

    if (shouldReset) {
        targetChatId = '';
        deviceAlias = deviceId;
        isUnlinkedNow = true;
        await env.DB.prepare("DELETE FROM guests WHERE device_id = ?").bind(deviceId).run();
    } else if (chatId) {
        isUnlinkedNow = false;
    }

    let hasOpenCut = false;
    let openCut = null;
    let blackoutStart = null;

    if (wasBlackout || Boolean(existing?.blackoutStartTime) || Boolean(existing?.lastAlertMsgId) || (existing?.lastSeen && (now - existing.lastSeen) >= OFFLINE_THRESHOLD_MS)) {
        openCut = await env.DB.prepare("SELECT * FROM history WHERE device_id = ? AND end_time IS NULL ORDER BY start_time DESC LIMIT 1").bind(deviceId).first();
        hasOpenCut = Boolean(openCut);
    }

    if (hasOpenCut && openCut?.start_time) blackoutStart = openCut.start_time;
    else if (existing?.blackoutStartTime) blackoutStart = existing.blackoutStartTime;
    else if (existing?.lastSeen) blackoutStart = existing.lastSeen;
    else blackoutStart = now - OFFLINE_THRESHOLD_MS;

    const computedDurationMs = Math.max(now - blackoutStart, 60000);
    const chipStayedPoweredOn = boardUptimeMs > (computedDurationMs + 5000);
    const wasAlertSent = wasBlackout || Boolean(existing?.blackoutStartTime) || Boolean(existing?.lastAlertMsgId);
    const isReturnFromBlackout = !shouldReset && (wasAlertSent || computedDurationMs >= OFFLINE_THRESHOLD_MS);

    let onlineSince = existing?.onlineSince || (boardUptimeMs > 0 ? (now - boardUptimeMs) : now);
    if (isReturnFromBlackout && !chipStayedPoweredOn) {
        onlineSince = boardUptimeMs > 0 ? (now - boardUptimeMs) : now;
    }

    // Invariante matemático inviolable: onlineSince NUNCA puede ser anterior al fin del último corte registrado
    const lastCutRow = await env.DB.prepare("SELECT MAX(end_time) as last_cut_end FROM history WHERE device_id = ? AND end_time IS NOT NULL").bind(deviceId).first();
    if (lastCutRow && lastCutRow.last_cut_end && lastCutRow.last_cut_end > onlineSince) {
        onlineSince = lastCutRow.last_cut_end;
    }

    // Si regresa de un apagón
    if (isReturnFromBlackout && (existing?.lastSeen || existing?.blackoutStartTime || hasOpenCut)) {
        const durationFormatted = formatDuration(computedDurationMs);
        const returnTimeStr = formatVETime(now);
        const returnDateStr = formatVEDate(now);

        let eventType = 'power_outage';
        if (chipStayedPoweredOn) eventType = 'internet_drop';
        else if (Math.round(computedDurationMs / 60000) < 5) eventType = 'fluctuation';

        // Cerrar corte abierto en D1
        if (hasOpenCut && openCut) {
            await env.DB.prepare("UPDATE history SET end_time = ?, end_time_str = ?, end_date_str = ?, duration_str = ?, duration_ms = ?, event_type = ? WHERE id = ?")
                .bind(now, returnTimeStr, returnDateStr, durationFormatted, computedDurationMs, eventType, openCut.id).run();
        } else {
            const eventId = `event_${blackoutStart}`;
            await env.DB.prepare("INSERT OR REPLACE INTO history (id, device_id, start_time, end_time, start_time_str, end_time_str, start_date_str, end_date_str, duration_str, duration_ms, event_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
                .bind(eventId, deviceId, blackoutStart, now, formatVETime(blackoutStart), returnTimeStr, formatVEDate(blackoutStart), returnDateStr, durationFormatted, computedDurationMs, eventType).run();
        }

        const geoSuffix = (existing?.city && existing?.isp) ? ` <i>(${existing.city}, ${existing.region || ''} — ${existing.isp} 🌐)</i>` : '';

        let returnMsg = "";
        if (eventType === 'internet_drop') {
            returnMsg = `🌐 <b>¡SERVICIO DE INTERNET RESTABLECIDO!</b>\n\n` +
                        `📍 <b>Ubicación:</b> <code>${deviceAlias}</code>${geoSuffix}\n` +
                        `⏰ <b>Hora de reconexión:</b> ${returnTimeStr} (${returnDateStr})\n` +
                        `⏱️ <b>Tiempo sin conexión:</b> ${durationFormatted}\n\n` +
                        `💡 <i>Confirmado: **En tu casa SÍ hubo luz todo el tiempo**. La placa se mantuvo encendida continuamente; la interrupción fue de tu proveedor de internet / red.</i>\n\n` +
                        `📱 <b>Dispositivo:</b> <code>${deviceId}</code>\n` +
                        `🔗 <b>Monitor Web:</b> https://monitor-luz-vercel-six.vercel.app/?id=${deviceId}`;
        } else if (eventType === 'fluctuation') {
            returnMsg = `⚡ <b>¡ENERGÍA / RED NORMALIZADA!</b>\n\n` +
                        `📍 <b>Ubicación:</b> <code>${deviceAlias}</code>${geoSuffix}\n` +
                        `⏰ <b>Hora de restablecimiento:</b> ${returnTimeStr} (${returnDateStr})\n` +
                        `⏱️ <b>Tiempo fuera de línea:</b> ${durationFormatted}\n\n` +
                        `💡 <i>Fue un <b>micro-corte eléctrico</b> (bajón de voltaje) o un reinicio breve de red en tu casa.</i>\n\n` +
                        `📱 <b>Dispositivo:</b> <code>${deviceId}</code>\n` +
                        `🔗 <b>Monitor Web:</b> https://monitor-luz-vercel-six.vercel.app/?id=${deviceId}`;
        } else {
            returnMsg = `⚡ <b>¡VOLVIÓ LA LUZ!</b>\n\n` +
                        `📍 <b>Ubicación:</b> <code>${deviceAlias}</code>${geoSuffix}\n` +
                        `⏰ <b>Hora de regreso:</b> ${returnTimeStr} (${returnDateStr})\n` +
                        `⏱️ <b>Tiempo que duró el corte:</b> ${durationFormatted}\n\n` +
                        `La energía eléctrica ha regresado a tu casa.\n\n` +
                        `📱 <b>Dispositivo:</b> <code>${deviceId}</code>\n` +
                        `🔗 <b>Monitor Web:</b> https://monitor-luz-vercel-six.vercel.app/?id=${deviceId}`;
        }

        if (targetChatId && (wasAlertSent || computedDurationMs >= OFFLINE_THRESHOLD_MS)) {
            await sendTelegramMessage(targetChatId, returnMsg);
            const guestsRows = await env.DB.prepare("SELECT guest_chat_id FROM guests WHERE device_id = ?").bind(deviceId).all();
            for (const g of (guestsRows.results || [])) {
                const gId = String(g.guest_chat_id).trim();
                if (gId && gId !== targetChatId) {
                    await sendTelegramMessage(gId, returnMsg, [
                        [{ text: "📊 Consultar Estado en Vivo", callback_data: `/estado_${deviceId}` }]
                    ]);
                }
            }
        }
    }

    // Geolocalización y detección anti-datacenter
    const geo = await resolveGeo(request, clientIp, existing, deviceId);
    const city = geo.city;
    const region = geo.region;
    const isp = geo.isp;

    // Guardar dispositivo en D1
    await env.DB.prepare(`
        INSERT INTO devices (device_id, alias, chat_id, last_seen, online_since, blackout_notified, blackout_start_time, last_alert_msg_id, last_alert_messages, ip, city, region, isp, unlinked, reset_requested, updated_at)
        VALUES (?, ?, ?, ?, ?, 0, NULL, NULL, '{}', ?, ?, ?, ?, ?, 0, ?)
        ON CONFLICT(device_id) DO UPDATE SET
            alias = excluded.alias,
            chat_id = excluded.chat_id,
            last_seen = excluded.last_seen,
            online_since = excluded.online_since,
            blackout_notified = 0,
            blackout_start_time = NULL,
            last_alert_msg_id = NULL,
            last_alert_messages = '{}',
            ip = excluded.ip,
            city = excluded.city,
            region = excluded.region,
            isp = excluded.isp,
            unlinked = excluded.unlinked,
            reset_requested = 0,
            updated_at = excluded.updated_at
    `).bind(
        deviceId,
        deviceAlias,
        targetChatId,
        now,
        onlineSince,
        clientIp,
        city,
        region,
        isp,
        isUnlinkedNow ? 1 : 0,
        existing ? existing.updatedAt : now
    ).run();

    return new Response(JSON.stringify({
        success: true,
        timestamp: now,
        action: shouldReset ? 'RESET_WIFI' : 'NONE'
    }), {
        headers: { 'Content-Type': 'application/json' }
    });
}

// --- COMANDOS CRON AUTOMÁTICOS (CADA 1 MINUTO) ---

async function syncWithRender(env) {
    try {
        const renderRes = await fetch('https://monitor-luz-vercel.onrender.com/api/devices', {
            headers: { 'User-Agent': 'PowerWatch-Sync/1.0' },
            cf: { cacheTtl: 0 }
        });
        if (renderRes.ok) {
            const renderDevs = await renderRes.json();
            if (Array.isArray(renderDevs)) {
                for (const rd of renderDevs) {
                    if (!rd || !rd.deviceId || rd.deviceId.startsWith('TEST') || rd.deviceId.startsWith('PROBE') || rd.unlinked) continue;
                    
                    const existing = await env.DB.prepare("SELECT last_seen, blackout_notified, blackout_start_time FROM devices WHERE device_id = ?").bind(rd.deviceId).first();
                    if (existing) {
                        const rLastSeen = Number(rd.lastSeen || 0);
                        const exLastSeen = Number(existing.last_seen || 0);
                        if (rLastSeen > exLastSeen) {
                            const isNowOnline = (Date.now() - rLastSeen) < OFFLINE_THRESHOLD_MS;
                            if (isNowOnline) {
                                const hadBlackout = Boolean(existing.blackout_notified || existing.blackout_start_time);
                                const openCut = await env.DB.prepare("SELECT id FROM history WHERE device_id = ? AND end_time IS NULL").bind(rd.deviceId).first();
                                const wasInBlackout = hadBlackout || Boolean(openCut);

                                await env.DB.prepare(`
                                    UPDATE devices 
                                    SET last_seen = ?, 
                                        online_since = CASE WHEN (? = 1 OR online_since = 0) THEN ? ELSE online_since END,
                                        blackout_notified = 0, 
                                        blackout_start_time = NULL,
                                        updated_at = ?
                                    WHERE device_id = ?
                                `).bind(rLastSeen, wasInBlackout ? 1 : 0, rLastSeen, Date.now(), rd.deviceId).run();

                                // Si tenía corte abierto en D1, cerrarlo con tiempos y duración formateados
                                if (openCut) {
                                    const durMs = Math.max(0, rLastSeen - (existing.blackout_start_time || rLastSeen));
                                    const durStr = formatDuration(durMs);
                                    const endTStr = formatVETime(rLastSeen);
                                    const endDStr = formatVEDate(rLastSeen);
                                    await env.DB.prepare(`
                                        UPDATE history 
                                        SET end_time = ?, 
                                            end_time_str = ?,
                                            end_date_str = ?,
                                            duration_ms = ?, 
                                            duration_str = ? 
                                        WHERE id = ?
                                    `).bind(rLastSeen, endTStr, endDStr, durMs, durStr, openCut.id).run();
                                }
                            } else {
                                await env.DB.prepare(`
                                    UPDATE devices 
                                    SET last_seen = ?, 
                                        updated_at = ?
                                    WHERE device_id = ?
                                `).bind(rLastSeen, Date.now(), rd.deviceId).run();
                            }
                        }
                    }
                }
            }
        }
    } catch (e) {
        console.error('[SYNC RENDER ERROR]:', e.message);
    }
}

async function checkBlackoutAlerts(env) {
    // Sincronización bidireccional automática en la nube con Render antes de evaluar desconexiones
    await syncWithRender(env);

    const now = Date.now();
    const threshold = now - OFFLINE_THRESHOLD_MS;

    const devsRows = await env.DB.prepare(`
        SELECT * FROM devices 
        WHERE last_seen > 0 
          AND last_seen <= ? 
          AND blackout_notified = 0 
          AND unlinked = 0 
          AND chat_id != ''
    `).bind(threshold).all();

    for (const dev of (devsRows.results || [])) {
        const deviceId = dev.device_id;
        const devChatId = String(dev.chat_id || '').trim();
        if (!devChatId) continue;

        const timeStr = formatVETime(dev.last_seen);
        const dateStr = formatVEDate(dev.last_seen);
        const devName = dev.alias || deviceId;

        const geoSuffix = (dev.city && dev.isp) ? ` <i>(${dev.city}, ${dev.region || ''} — ${dev.isp} 🌐)</i>` : '';

        const alertMsg = `🔴 <b>¡ALERTA DE CORTE DE ENERGÍA / DESCONEXIÓN!</b> 🔴\n\n` +
                         `📍 <b>Ubicación:</b> <b>${devName}</b>${geoSuffix}\n` +
                         `📱 <b>Dispositivo:</b> <code>${deviceId}</code>\n` +
                         `⏰ <b>Hora de desconexión:</b> ${timeStr} (${dateStr})\n\n` +
                         `El monitor ha dejado de reportar a nuestros servidores. Es muy probable que se haya ido la luz en tu zona o haya una interrupción del servicio eléctrico.\n\n` +
                         `🔗 <b>Monitor Web:</b> https://monitor-luz-vercel-six.vercel.app/?id=${deviceId}`;

        const ownerSend = await sendTelegramMessage(devChatId, alertMsg);
        const lastAlertMessages = {};
        if (ownerSend.messageId) lastAlertMessages[devChatId] = ownerSend.messageId;

        const guestsRows = await env.DB.prepare("SELECT guest_chat_id FROM guests WHERE device_id = ?").bind(deviceId).all();
        for (const g of (guestsRows.results || [])) {
            const gId = String(g.guest_chat_id).trim();
            if (gId && gId !== devChatId) {
                const gSend = await sendTelegramMessage(gId, alertMsg, [
                    [{ text: "📊 Consultar Estado en Vivo", callback_data: `/estado_${deviceId}` }]
                ]);
                if (gSend.messageId) lastAlertMessages[gId] = gSend.messageId;
            }
        }

        const eventId = `event_${dev.last_seen}`;
        await env.DB.prepare(`
            INSERT OR REPLACE INTO history (id, device_id, start_time, end_time, start_time_str, end_time_str, start_date_str, end_date_str, duration_str, duration_ms, event_type)
            VALUES (?, ?, ?, NULL, ?, NULL, ?, NULL, 'En curso...', 0, 'power_outage')
        `).bind(eventId, deviceId, dev.last_seen, timeStr, dateStr).run();

        await env.DB.prepare(`
            UPDATE devices 
            SET blackout_notified = 1,
                blackout_start_time = ?,
                last_alert_msg_id = ?,
                last_alert_messages = ?
            WHERE device_id = ?
        `).bind(dev.last_seen, ownerSend.messageId || null, JSON.stringify(lastAlertMessages), deviceId).run();

        console.log(`[ALERT] Notified blackout for ${deviceId}`);
    }
}

// --- ENDPOINT PROXY BINANCE P2P (VES / USDT) ---

let p2pGlobalCache = {};

async function handleP2p(request, env) {
    const url = new URL(request.url);
    const tradeType = (url.searchParams.get('tradeType') || 'BUY').toUpperCase();
    const payType = url.searchParams.get('payType') || '';
    const transAmount = url.searchParams.get('transAmount') || '';
    const rows = parseInt(url.searchParams.get('rows') || '15', 10);
    const cacheKey = `${tradeType}_${payType}_${transAmount}`;

    try {
        const payTypes = (payType && payType !== 'ALL') ? [payType] : [];

        const payload = {
            asset: 'USDT',
            fiat: 'VES',
            merchantCheck: false,
            page: 1,
            payTypes: payTypes,
            publisherType: null,
            rows: Math.min(rows, 20),
            tradeType: tradeType,
            transAmount: transAmount ? String(transAmount) : undefined
        };

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 6000);

        const binanceRes = await fetch('https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search', {
            method: 'POST',
            signal: controller.signal,
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            },
            body: JSON.stringify(payload)
        }).finally(() => clearTimeout(timeoutId));

        if (!binanceRes.ok) {
            if (p2pGlobalCache[cacheKey]) {
                return new Response(JSON.stringify(p2pGlobalCache[cacheKey]), {
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            }
            return new Response(JSON.stringify({ success: false, error: 'Binance P2P error: ' + binanceRes.status }), {
                status: 502,
                headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
            });
        }

        const data = await binanceRes.json();
        const rawAds = (data && data.data) ? data.data : [];

        if (rawAds.length === 0 && p2pGlobalCache[cacheKey]) {
            return new Response(JSON.stringify(p2pGlobalCache[cacheKey]), {
                headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
            });
        }

        const ads = rawAds.map(item => {
            const adv = item.adv || {};
            const advr = item.advertiser || {};
            const methods = (adv.tradeMethods || []).map(m => m.tradeMethodName || m.identifier).filter(Boolean);
            const ratePct = advr.monthFinishRate ? (advr.monthFinishRate * 100).toFixed(1) + '%' : '100%';

            return {
                name: advr.nickName || 'Comerciante',
                orders: advr.monthOrderCount || 0,
                rate: ratePct,
                price: parseFloat(adv.price || 0).toFixed(2),
                min: adv.minSingleTransAmount || '0',
                max: adv.dynamicMaxSingleTransAmount || adv.maxSingleTransAmount || '0',
                crypto: parseFloat(adv.tradableQuantity || adv.surplusAmount || 0).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
                banks: methods.slice(0, 2)
            };
        });

        const now = new Date();
        const timeStr = now.toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true, timeZone: 'America/Caracas' });

        const responseObj = {
            success: true,
            updatedAt: timeStr,
            total: ads.length,
            ads: ads
        };

        p2pGlobalCache[cacheKey] = responseObj;

        return new Response(JSON.stringify(responseObj), {
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'public, s-maxage=6, stale-while-revalidate=4'
            }
        });
    } catch (e) {
        if (p2pGlobalCache[cacheKey]) {
            return new Response(JSON.stringify(p2pGlobalCache[cacheKey]), {
                headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
            });
        }
        return new Response(JSON.stringify({ success: false, error: e.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
    }
}

async function handleP2pAlert(request, env) {
    try {
        let body = {};
        try { body = await request.json(); } catch(e) {}
        const targetChatId = (body.chatId || '330749449').toString().trim();
        const tradeType = (body.tradeType || 'BUY').toUpperCase();
        const targetPrice = body.targetPrice || '0.00';
        const price = body.price || '0.00';
        const trader = body.trader || 'Comerciante P2P';
        const orders = body.orders || 0;
        const rate = body.rate || '100%';
        const bank = Array.isArray(body.bank) ? body.bank.join(', ') : (body.bank || 'Todos los Métodos');
        const crypto = body.crypto || '0.00';

        const now = new Date();
        const timeStr = now.toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true, timeZone: 'America/Caracas' });

        const typeLabel = (tradeType === 'BUY') ? '🟢 COMPRAR USDT' : '🔴 VENDER USDT';

        const alertMsg = `🔔 <b>¡ALERTA P2P BINANCE! (PUESTO #1)</b> 🎯\n\n` +
                         `💵 <b>Operación:</b> <b>${typeLabel}</b>\n` +
                         `🎯 <b>Precio Objetivo Fijado:</b> <code>Bs ${targetPrice}</code>\n` +
                         `⚡ <b>Precio Oferta #1:</b> <b>Bs ${price}</b>\n` +
                         `━━━━━━━━━━━━━━━━━━━━\n` +
                         `👤 <b>Comerciante:</b> <b>${trader}</b>\n` +
                         `📊 <b>Reputación:</b> ${orders} órdenes (${rate})\n` +
                         `🏦 <b>Banco / Método:</b> ${bank}\n` +
                         `💰 <b>Saldo Disponible:</b> ${crypto} USDT\n` +
                         `⏰ <b>Hora de detección:</b> ${timeStr}\n\n` +
                         `🔗 <a href="https://p2p.binance.com/es/trade/all-payments/USDT?fiat=VES">Abrir Binance P2P</a>`;

        const result = await sendTelegramMessage(targetChatId, alertMsg, [
            [{ text: "📊 Ver Binance P2P Web", url: "https://p2p.binance.com/es/trade/all-payments/USDT?fiat=VES" }]
        ]);

        return new Response(JSON.stringify({ success: true, delivered: result.success }), {
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
    } catch (e) {
        return new Response(JSON.stringify({ success: false, error: e.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
    }
}

// --- WORKER ENTRYPOINT ---

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const pathname = url.pathname;

        // CORS headers
        const corsHeaders = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization'
        };

        if (request.method === 'OPTIONS') {
            return new Response(null, { headers: corsHeaders });
        }

        // Endpoint Proxy Binance P2P para pantalla ESP32 CYD
        if (pathname === '/api/p2p') {
            return await handleP2p(request, env);
        }

        // Endpoint Alerta Telegram Binance P2P
        if (pathname === '/api/p2p-alert' && request.method === 'POST') {
            return await handleP2pAlert(request, env);
        }

        // Endpoint de Ping de la placa ESP8266
        if (pathname === '/api/ping' && request.method === 'POST') {
            const res = await handlePing(request, env);
            return new Response(res.body, { status: res.status, headers: { ...corsHeaders, ...res.headers } });
        }

        // Endpoint Webhook de Telegram
        if (pathname === '/api/telegram-webhook' && request.method === 'POST') {
            return await handleTelegramWebhook(request, env);
        }

        // Endpoint lista de dispositivos en vivo (para el dashboard web y sincronización segura)
        if (pathname === '/api/devices' && request.method === 'GET') {
            const devs = await getAllDevicesFull(env.DB);
            const userAgent = request.headers.get('User-Agent') || '';
            const adminKey = request.headers.get('X-Admin-Key') || url.searchParams.get('key') || '';
            const reqChatId = url.searchParams.get('chatId') || request.headers.get('x-chat-id') || '';

            const isAuthorized = userAgent.includes('PowerWatch-Sync') || 
                                 adminKey === 'powerwatch-admin-secret-2026' || 
                                 reqChatId === '330749449';

            if (isAuthorized) {
                return new Response(JSON.stringify(devs), {
                    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
                });
            }

            // Sanitización estricta para visitantes anónimos / públicos (Privacidad absoluta de clientes)
            const sanitized = devs.map(d => ({
                deviceId: d.deviceId,
                alias: d.alias,
                status: (Date.now() - (d.lastSeen || 0)) < OFFLINE_THRESHOLD_MS ? 'online' : 'offline',
                lastSeen: d.lastSeen,
                onlineSince: d.onlineSince
            }));

            return new Response(JSON.stringify(sanitized), {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }

        // Endpoint historial de cortes por dispositivo
        if (pathname.startsWith('/api/history/') && request.method === 'GET') {
            const devId = pathname.replace('/api/history/', '').toUpperCase().trim();
            const dev = await getDeviceFull(env.DB, devId);
            return new Response(JSON.stringify(dev?.history || []), {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }

        // Endpoint estado detallado para el aplicativo web (index.html / estado.html)
        if (pathname.startsWith('/api/status/')) {
            const devId = pathname.replace('/api/status/', '').toUpperCase().trim();
            const reqChatId = url.searchParams.get('chatId') || request.headers.get('x-chat-id') || '';
            const dev = await getDeviceFull(env.DB, devId);

            if (!dev) {
                return new Response(JSON.stringify({
                    found: false,
                    deviceId: devId,
                    alias: devId,
                    status: 'offline',
                    message: 'SE FUE LA LUZ',
                    history: [],
                    isOwner: true,
                    isGuest: false,
                    role: 'owner',
                    roleLabel: 'Titular'
                }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
            }

            const isOwner = checkIsOwner(dev, reqChatId);
            const role = isOwner ? 'owner' : 'guest';
            const roleLabel = isOwner ? 'Titular' : 'Familiar Invitado';

            if (dev.unlinked) {
                return new Response(JSON.stringify({
                    found: true,
                    deviceId: dev.deviceId,
                    alias: dev.alias,
                    lastSeen: dev.lastSeen,
                    status: 'unlinked',
                    message: 'DISPOSITIVO DESVINCULADO',
                    history: dev.history || [],
                    isOwner: isOwner,
                    isGuest: !isOwner,
                    role: role,
                    roleLabel: roleLabel
                }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
            }

            const now = Date.now();
            const elapsedMs = now - dev.lastSeen;
            const isOnline = elapsedMs < OFFLINE_THRESHOLD_MS;
            let effectiveOnlineSince = dev.onlineSince || dev.lastSeen;
            const historyList = dev.history || [];
            if (historyList.length > 0) {
                const lastEndedCut = historyList.find(h => h && h.end);
                if (lastEndedCut && lastEndedCut.end && lastEndedCut.end > effectiveOnlineSince) {
                    effectiveOnlineSince = lastEndedCut.end;
                }
            }
            const uptimeMs = isOnline ? Math.max(0, now - effectiveOnlineSince) : 0;

            return new Response(JSON.stringify({
                found: true,
                deviceId: dev.deviceId,
                alias: dev.alias,
                lastSeen: dev.lastSeen,
                onlineSince: effectiveOnlineSince,
                elapsedMs: elapsedMs,
                uptimeMs: uptimeMs,
                status: isOnline ? 'online' : 'offline',
                message: isOnline ? 'HAY LUZ' : 'SE FUE LA LUZ',
                history: dev.history || [],
                isOwner: isOwner,
                isGuest: !isOwner,
                role: role,
                roleLabel: roleLabel
            }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }

        // Endpoint lista de dispositivos para devices.html y admin.html
        if (pathname === '/api/devices-list' && request.method === 'GET') {
            let reqChatId = url.searchParams.get('chatId') || request.headers.get('x-chat-id') || '';
            if (reqChatId === '3307499449') reqChatId = '330749449';
            let devs = [];
            if (reqChatId) {
                devs = await getDevicesForUser(env.DB, reqChatId);
            } else {
                devs = await getAllDevicesOptimized(env.DB);
            }

            const now = Date.now();
            const formattedDevices = devs.map(dev => {
                if (dev.unlinked) return null;
                const elapsedMs = dev.lastSeen ? Math.max(0, now - dev.lastSeen) : null;
                const isOnline = dev.lastSeen && elapsedMs !== null && elapsedMs < OFFLINE_THRESHOLD_MS;
                const uptimeMs = (isOnline && dev.onlineSince) ? Math.max(0, now - dev.onlineSince) : 0;
                const isOwner = checkIsOwner(dev, reqChatId);

                return {
                    deviceId: dev.deviceId,
                    alias: dev.alias || dev.deviceId,
                    lastSeen: dev.lastSeen || 0,
                    elapsedMs: elapsedMs,
                    uptimeMs: uptimeMs,
                    statusCode: isOnline ? 'online' : 'offline',
                    history: dev.history || [],
                    isOwner: isOwner,
                    isGuest: !isOwner,
                    role: isOwner ? 'propietario' : 'invitado',
                    roleLabel: isOwner ? 'Propietario' : 'Invitado',
                    city: dev.city || '',
                    region: dev.region || '',
                    isp: dev.isp || '',
                    ip: dev.ip || ''
                };
            }).filter(Boolean);

            formattedDevices.sort((a, b) => {
                if (a.statusCode === 'offline' && b.statusCode !== 'offline') return -1;
                if (a.statusCode !== 'offline' && b.statusCode === 'offline') return 1;
                return (b.lastSeen || 0) - (a.lastSeen || 0);
            });

            return new Response(JSON.stringify({
                devices: formattedDevices,
                total: formattedDevices.length
            }), {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }

        // Endpoint borrar historial desde la web
        if (pathname === '/api/clear-history' && request.method === 'POST') {
            let body = {};
            try { body = await request.json(); } catch(e) {}
            const devId = (body.deviceId || body.id || '').toString().trim().toUpperCase();
            const reqChatId = (body.chatId || request.headers.get('x-chat-id') || '').toString().trim();
            const dev = await getDeviceFull(env.DB, devId);

            if (!dev) return new Response(JSON.stringify({ error: 'Dispositivo no encontrado' }), { status: 404, headers: corsHeaders });
            if (!checkIsOwner(dev, reqChatId, true)) {
                return new Response(JSON.stringify({ error: 'Acceso denegado: solo el titular puede borrar el historial' }), { status: 403, headers: corsHeaders });
            }

            await env.DB.prepare("DELETE FROM history WHERE device_id = ?").bind(devId).run();
            return new Response(JSON.stringify({ success: true, message: 'Historial borrado' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }

        // Endpoint reiniciar WiFi desde la web
        if (pathname === '/api/reset-wifi' && request.method === 'POST') {
            let body = {};
            try { body = await request.json(); } catch(e) {}
            const devId = (body.deviceId || body.id || '').toString().trim().toUpperCase();
            const reqChatId = (body.chatId || request.headers.get('x-chat-id') || '').toString().trim();
            const dev = await getDeviceFull(env.DB, devId);

            if (!dev) return new Response(JSON.stringify({ error: 'Dispositivo no encontrado' }), { status: 404, headers: corsHeaders });
            if (!checkIsOwner(dev, reqChatId, true)) {
                return new Response(JSON.stringify({ error: 'Acceso denegado: solo el titular puede reiniciar' }), { status: 403, headers: corsHeaders });
            }

            await env.DB.prepare("UPDATE devices SET reset_requested = 1, updated_at = ? WHERE device_id = ?").bind(Date.now(), devId).run();
            return new Response(JSON.stringify({ success: true, message: 'Orden de reinicio enviada' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }

        // Endpoint detalle de un dispositivo
        if (pathname.startsWith('/api/device/') && request.method === 'GET') {
            const devId = pathname.replace('/api/device/', '').toUpperCase().trim();
            const dev = await getDeviceFull(env.DB, devId);
            if (!dev) return new Response(JSON.stringify({ error: 'Device not found' }), { status: 404, headers: corsHeaders });
            return new Response(JSON.stringify(dev), {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }

        // Endpoint debug para inspeccionar cabeceras e IP detectada
        if (pathname === '/api/debug-ip') {
            const headersObj = {};
            for (const [k, v] of request.headers.entries()) {
                headersObj[k] = v;
            }
            return new Response(JSON.stringify({
                cf: request.cf,
                headers: headersObj,
                detectedClientIp: getClientIp(request)
            }, null, 2), {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }

        // Root / healthcheck
        if (pathname === '/' || pathname === '/api/health') {
            return new Response(JSON.stringify({ status: 'ok', service: 'PowerWatch Cloudflare Worker', timestamp: Date.now() }), {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }

        return new Response('Not Found', { status: 404, headers: corsHeaders });
    },

    // Cron Trigger automático ejecutado cada minuto por Cloudflare
    async scheduled(event, env, ctx) {
        ctx.waitUntil(checkBlackoutAlerts(env));
    }
};
