const SUPABASE_URL = "https://anidcxlmjiyrjsbvchrs.supabase.co";
const SUPABASE_KEY = "sb_publishable_An-AXhwWYFlFEZ4oxfK8qg_kuaW7rOI";

const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

const loginScreen = document.getElementById("loginScreen");
const dashboardScreen = document.getElementById("dashboardScreen");
const userScreen = document.getElementById("userScreen");
const loginForm = document.getElementById("loginForm");
const loginMessage = document.getElementById("loginMessage");
const loginButton = document.getElementById("loginButton");

let checkingSession = false;
let userMap = null;
let userMarker = null;
let watchPositionId = null;
let currentUserSessionId = null;

let profilesChannel = null;
let liveMap = null;
let liveMarkers = {};
let liveUserData = {};
let livePollTimer = null;
let batteryTimer = null;
let batteryVisibilityHandler = null;

let adminSelfId = null;

let lastGeoLat = null;
let lastGeoLng = null;
let lastPlaceName = null;

// ===== Login / screen routing =====
function showLogin(message = "") {
  dashboardScreen.classList.add("hidden");
  userScreen.classList.add("hidden");
  loginScreen.classList.remove("hidden");
  loginMessage.textContent = message;
  loginButton.disabled = false;
  loginForm.reset();

  stopBatteryHeartbeat();
  stopLivePoll();
  stopInboxRealtime();
  liveMap = null;
  stopAdminRealtime();

  if (watchPositionId !== null) {
    navigator.geolocation.clearWatch(watchPositionId);
    watchPositionId = null;
  }
}

function showAdminDashboard(profile) {
  loginScreen.classList.add("hidden");
  userScreen.classList.add("hidden");
  dashboardScreen.classList.remove("hidden");
  document.getElementById("welcomeText").textContent =
    "Welcome, " + profile.full_name + " (Admin)";

  startAdminRealtime();
}

function showUserDashboard(profile, user) {
  loginScreen.classList.add("hidden");
  dashboardScreen.classList.add("hidden");
  userScreen.classList.remove("hidden");
  document.getElementById("userWelcome").textContent = "Kumusta, " + profile.full_name + "!";
  currentUserSessionId = user.id;

  initUserMap();
  startUserTracking(user.id);
  startBatteryHeartbeat(user.id);
  startInboxRealtime(user.id);
}

async function verifyAndRouteUser(user) {
  const { data: profile, error } = await db
    .from("profiles")
    .select("full_name, role, location_sharing")
    .eq("id", user.id)
    .single();

  if (error || !profile) {
    await db.auth.signOut();
    showLogin("Hindi nahanap ang profile access.");
    return false;
  }

  if (profile.role === "admin") {
    adminSelfId = user.id;
    showAdminDashboard(profile);
  } else {
    writeLocationLog(user.id, { event: "login" });
    await db.from("profiles").update({ is_online: true }).eq("id", user.id);
    showUserDashboard(profile, user);
  }

  return true;
}

loginForm.addEventListener("submit", async function (event) {
  event.preventDefault();

  loginButton.disabled = true;
  loginMessage.textContent = "Sinusuri ang login...";

  const email = document.getElementById("email").value.trim();
  const password = document.getElementById("password").value;

  const { data, error } = await db.auth.signInWithPassword({ email, password });

  if (error) {
    showLogin("Login failed: " + error.message);
    return;
  }

  await verifyAndRouteUser(data.user);
});

async function handleLogout() {
  if (!confirm("Sigurado ka bang mag-logout?")) return;

  const userIdToLogout = currentUserSessionId;
  currentUserSessionId = null;

  if (watchPositionId !== null) {
    navigator.geolocation.clearWatch(watchPositionId);
    watchPositionId = null;
  }
  stopBatteryHeartbeat();

  if (userIdToLogout) {
    writeLocationLog(userIdToLogout, { event: "logout" });

    const { error } = await db
      .from("profiles")
      .update({ is_online: false, location_sharing: false })
      .eq("id", userIdToLogout);

    if (error) console.error("Error sa pag-update ng status:", error);
  }

  await db.auth.signOut();
  showLogin("Matagumpay ang logout.");
}

document.getElementById("logoutAdmin").addEventListener("click", handleLogout);
document.getElementById("logoutUser").addEventListener("click", handleLogout);

// ===== Admin realtime =====
function startAdminRealtime() {
  if (profilesChannel) return;

  profilesChannel = db
    .channel("profiles-live")
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "profiles" },
      (payload) => handleProfileUpdate(payload.old, payload.new)
    )
    .subscribe();
}

function stopAdminRealtime() {
  if (profilesChannel) {
    db.removeChannel(profilesChannel);
    profilesChannel = null;
  }
}

function batteryLabel(user) {
  return user.battery_level != null
    ? `${user.battery_level}%${user.is_charging ? " ⚡" : ""}`
    : "N/A";
}

function liveStatusBadge(online) {
  return online
    ? '<span style="color:#137333;font-weight:bold;">🟢 Online</span>'
    : '<span style="color:#64748b;">⚪ Offline</span>';
}

function shortPlace(name) {
  if (!name) return "Hindi pa alam ang lugar";
  return name.split(",").slice(0, 2).join(",").trim();
}

function handleProfileUpdate(oldRow, newRow) {
  const page = document.querySelector("#menu button.active")?.dataset.page;

  const statusChanged = oldRow?.is_online !== newRow.is_online;
  const batteryChanged =
    oldRow?.battery_level !== newRow.battery_level ||
    oldRow?.is_charging !== newRow.is_charging;
  const locationChanged =
    oldRow?.latitude !== newRow.latitude ||
    oldRow?.longitude !== newRow.longitude ||
    oldRow?.location_name !== newRow.location_name;

  if (!statusChanged && !batteryChanged && !locationChanged) return;

  if (page === "Users / Accounts") {
    const row = document.querySelector(`tr[data-user-id="${newRow.id}"]`);
    if (!row) return;

    if (statusChanged) {
      const cell = row.querySelector(".status-cell");
      if (cell) {
        cell.innerHTML = "";
        const badge = document.createElement("span");
        badge.className = newRow.is_online ? "badge-online" : "badge-offline";
        badge.textContent = newRow.is_online ? "Online" : "Offline";
        cell.appendChild(badge);
      }
    }

    if (batteryChanged) {
      const cell = row.querySelector(".battery-cell");
      if (cell) cell.textContent = batteryLabel(newRow);
    }
  } else if (page === "Live GPS Map" && liveMap) {
    renderLiveUser(newRow);
  }
}

// ===== User map =====
function initUserMap() {
  if (userMap) return;
  if (typeof maplibregl === "undefined") {
    console.error("Hindi na-load ang MapLibre.");
    return;
  }

  userMap = new maplibregl.Map({
    container: "userMapContainer",
    style: "https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json",
    center: [120.9842, 14.5995],
    zoom: 14
  });

  userMap.addControl(new maplibregl.NavigationControl());
}

// ===== Chat (iisang view para sa user at admin) =====
let activeChat = null;

function destroyActiveChat() {
  if (activeChat) {
    try { activeChat.destroy(); } catch (e) {}
    activeChat = null;
  }
}

function chatUIHtml(p, title, height) {
  return `
    ${title ? `<div style="padding:8px 10px;background:#1769aa;color:#fff;font-weight:bold;">${title}</div>` : ""}
    <div id="${p}List" style="height:${height}px;overflow-y:auto;padding:8px;display:flex;flex-direction:column;gap:8px;background:#f8fafc;"></div>
    <div style="display:flex;gap:6px;padding:8px;border-top:1px solid #e2e8f0;background:#fff;">
      <input id="${p}Input" type="text" placeholder="I-type ang mensahe..." style="flex:1;padding:8px;border:1px solid #cbd5e1;border-radius:6px;">
      <button id="${p}Send" type="button" style="padding:8px 12px;background:#1769aa;color:#fff;border:none;border-radius:6px;">Ipadala</button>
    </div>
    <div id="${p}Status" style="font-size:12px;color:#b42318;padding:0 10px 6px;"></div>
  `;
}

function chatBubble(m, myId) {
  const mine = m.from_id === myId;

  const wrap = document.createElement("div");
  wrap.style.cssText = `display:flex;flex-direction:column;align-items:${mine ? "flex-end" : "flex-start"};`;

  const bubble = document.createElement("div");
  bubble.style.cssText =
    "max-width:80%;padding:8px 10px;border-radius:12px;font-size:14px;line-height:1.4;word-break:break-word;" +
    (mine
      ? "background:#1769aa;color:#fff;"
      : "background:#fff;color:#1e293b;border:1px solid #e2e8f0;");
  bubble.textContent = m.body;

  const time = document.createElement("div");
  time.style.cssText = "font-size:10px;color:#64748b;margin-top:2px;";
  time.textContent =
    (mine ? "Ikaw" : "Kausap") + " · " +
    new Date(m.created_at).toLocaleString("fil-PH", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

  wrap.appendChild(bubble);
  wrap.appendChild(time);
  return wrap;
}

async function fetchChatPair(myId, otherId) {
  const { data, error } = await db
    .from("messages")
    .select("id, from_id, to_id, body, created_at")
    .or(`and(from_id.eq.${myId},to_id.eq.${otherId}),and(from_id.eq.${otherId},to_id.eq.${myId})`)
    .order("created_at", { ascending: true })
    .limit(300);

  if (error) throw error;
  return data || [];
}

async function getAdminId() {
  const { data } = await db
    .from("profiles")
    .select("id")
    .eq("role", "admin")
    .limit(1)
    .maybeSingle();
  return data ? data.id : null;
}

async function getCurrentUserId() {
  const { data } = await db.auth.getUser();
  return data && data.user ? data.user.id : null;
}

// Gumawa ng chat view sa loob ng container, at makinig sa bagong mensahe ng pag-uusap
async function mountChat(container, p, title, height, myId, otherId) {
  destroyActiveChat();
  container.innerHTML = chatUIHtml(p, title, height);

  const list = document.getElementById(p + "List");
  const input = document.getElementById(p + "Input");
  const sendBtn = document.getElementById(p + "Send");
  const status = document.getElementById(p + "Status");
  const seen = new Set();

  const emptyHtml = "<div class='chat-empty' style='color:#64748b;font-size:13px;text-align:center;'>Walang mensahe.</div>";

  const addMsg = (m) => {
    if (seen.has(m.id)) return;
    seen.add(m.id);
    const empty = list.querySelector(".chat-empty");
    if (empty) empty.remove();
    list.appendChild(chatBubble(m, myId));
    list.scrollTop = list.scrollHeight;
  };

  list.innerHTML = "<div class='chat-empty' style='color:#64748b;font-size:13px;text-align:center;'>Naglo-load...</div>";

  try {
    const rows = await fetchChatPair(myId, otherId);
    list.innerHTML = "";
    if (rows.length === 0) list.innerHTML = emptyHtml;
    rows.forEach(addMsg);
  } catch (e) {
    list.innerHTML = "";
    status.textContent = "Error: " + e.message;
  }

  const send = async () => {
    const body = input.value.trim();
    if (!body || !myId || !otherId) return;

    input.disabled = true;
    sendBtn.disabled = true;
    status.textContent = "";

    const { data, error } = await db
      .from("messages")
      .insert({ from_id: myId, to_id: otherId, body })
      .select("id, from_id, to_id, body, created_at")
      .single();

    input.disabled = false;
    sendBtn.disabled = false;

    if (error) {
      status.textContent = "Error: " + error.message;
      return;
    }

    input.value = "";
    input.focus();
    if (data) addMsg(data);
  };

  sendBtn.onclick = send;
  input.onkeydown = (e) => { if (e.key === "Enter") send(); };

  const channel = db
    .channel(`chat-${p}-${myId}-${otherId}-${Date.now()}`)
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "messages" },
      (payload) => {
        const m = payload.new;
        const pair =
          (m.from_id === myId && m.to_id === otherId) ||
          (m.from_id === otherId && m.to_id === myId);
        if (pair) addMsg(m);
      }
    )
    .subscribe();

  activeChat = {
    destroy() { db.removeChannel(channel); }
  };
}

// ===== User side: chat box sa user page =====
async function startInboxRealtime(userId) {
  destroyActiveChat();

  const old = document.getElementById("chatBox");
  if (old) old.remove();

  const card = document.querySelector("#userScreen .card");
  const sos = document.getElementById("sosButton");

  const box = document.createElement("div");
  box.id = "chatBox";
  box.style.cssText = "margin-top:15px;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;background:#fff;";
  card.insertBefore(box, sos);

  const adminId = await getAdminId();
  if (!adminId) {
    box.innerHTML = "<div style='padding:10px;color:#b42318;font-size:13px;'>Hindi makita ang admin.</div>";
    return;
  }

  await mountChat(box, "uc", "💬 Chat sa Admin", 240, userId, adminId);
}

function stopInboxRealtime() {
  destroyActiveChat();
}

// ===== Admin side: panel ng usapan =====
function buildAdminChatPanel() {
  const panel = document.createElement("div");
  panel.id = "adminChatPanel";
  panel.style.cssText = "display:none;margin-top:15px;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;background:#fff;";
  panel.innerHTML = `
    <div style="padding:8px 10px;background:#1769aa;color:#fff;font-weight:bold;display:flex;justify-content:space-between;align-items:center;">
      <span id="adminChatTitle">💬 Usapan</span>
      <button id="adminChatClose" type="button" style="background:#fff;color:#1769aa;border:none;border-radius:4px;padding:2px 8px;">✕</button>
    </div>
    <div id="adminChatBody"></div>
  `;
  panel.querySelector("#adminChatClose").onclick = stopAdminChat;
  return panel;
}

async function openAdminChat(user) {
  const panel = document.getElementById("adminChatPanel");
  if (!panel) return;

  document.getElementById("adminChatTitle").textContent =
    "💬 Usapan: " + (user.full_name || user.email || "User");
  panel.style.display = "block";

  const myId = adminSelfId || (await getCurrentUserId());
  await mountChat(document.getElementById("adminChatBody"), "ac", "", 280, myId, user.id);

  panel.scrollIntoView({ behavior: "smooth", block: "start" });
}

function stopAdminChat() {
  destroyActiveChat();
  const panel = document.getElementById("adminChatPanel");
  if (panel) panel.style.display = "none";
}

// ===== Battery =====
async function getBatteryStatus() {
  if (!("getBattery" in navigator)) {
    return { level: null, charging: false };
  }
  try {
    const battery = await navigator.getBattery();
    return {
      level: Math.round(battery.level * 100),
      charging: battery.charging
    };
  } catch (e) {
    console.error("Battery error:", e);
    return { level: null, charging: false };
  }
}

async function pushBatteryStatus(userId) {
  if (!currentUserSessionId) return;

  const b = await getBatteryStatus();

  const updateData = { last_seen: new Date().toISOString() };
  if (b.level !== null) {
    updateData.battery_level = b.level;
    updateData.is_charging = b.charging;

    writeLocationLog(userId, {
      battery_level: b.level,
      is_charging: b.charging
    });
  }

  const { error } = await db.from("profiles").update(updateData).eq("id", userId);
  if (error) console.error("Battery update error:", error);
}

function startBatteryHeartbeat(userId) {
  stopBatteryHeartbeat();

  pushBatteryStatus(userId);

  batteryTimer = setInterval(() => {
    if (currentUserSessionId) pushBatteryStatus(userId);
  }, 30000);

  batteryVisibilityHandler = () => {
    if (document.visibilityState === "visible" && currentUserSessionId) {
      pushBatteryStatus(userId);
    }
  };
  document.addEventListener("visibilitychange", batteryVisibilityHandler);
}

function stopBatteryHeartbeat() {
  if (batteryTimer) {
    clearInterval(batteryTimer);
    batteryTimer = null;
  }

  if (batteryVisibilityHandler) {
    document.removeEventListener("visibilitychange", batteryVisibilityHandler);
    batteryVisibilityHandler = null;
  }
}

// ===== Location log (history) =====
async function writeLocationLog(userId, fields) {
  const { error } = await db.from("location_logs").insert({
    user_id: userId,
    event: fields.event ?? null,
    latitude: fields.latitude ?? null,
    longitude: fields.longitude ?? null,
    location_name: fields.location_name ?? null,
    battery_level: fields.battery_level ?? null,
    is_charging: fields.is_charging ?? null
  });

  if (error) {
    console.error("Log error:", error);
    alert("Log error: " + error.message);
  }
}

// ===== GPS tracking =====
function distanceMeters(lat1, lng1, lat2, lng2) {
  const dLat = (lat2 - lat1) * 111000;
  const dLng = (lng2 - lng1) * 111000 * Math.cos((lat1 * Math.PI) / 180);
  return Math.sqrt(dLat * dLat + dLng * dLng);
}

function startUserTracking(userId) {
  const gpsStatusText = document.getElementById("gpsStatusText");
  const userLocationName = document.getElementById("userLocationName");

  if (!("geolocation" in navigator)) {
    gpsStatusText.textContent = "Hindi supported ang Geolocation sa device na ito.";
    gpsStatusText.style.background = "#fde8e8";
    gpsStatusText.style.color = "#9b1c1c";
    return;
  }

  gpsStatusText.textContent = "🟢 Aktibo ang iyong GPS & Online Status";

  watchPositionId = navigator.geolocation.watchPosition(
    async (position) => {
      if (!currentUserSessionId) return;

      const lat = position.coords.latitude;
      const lng = position.coords.longitude;

      const moved =
        lastGeoLat === null ||
        distanceMeters(lastGeoLat, lastGeoLng, lat, lng) > 30;

      if (moved) {
        lastGeoLat = lat;
        lastGeoLng = lng;
        lastPlaceName = await fetchReverseGeocode(lat, lng);
        userLocationName.textContent = lastPlaceName;
      }

      if (!currentUserSessionId) return;

      const updateData = {
        location_sharing: true,
        is_online: true,
        latitude: lat,
        longitude: lng,
        last_seen: new Date().toISOString()
      };
      if (lastPlaceName) updateData.location_name = lastPlaceName;

      const { error: gpsErr } = await db
        .from("profiles")
        .update(updateData)
        .eq("id", userId);

      if (gpsErr) console.error("GPS update error:", gpsErr);

      writeLocationLog(userId, {
        latitude: lat,
        longitude: lng,
        location_name: lastPlaceName
      });

      if (userMap) {
        userMap.setCenter([lng, lat]);
        if (!userMarker) {
          userMarker = new maplibregl.Marker({ color: "#1769aa" })
            .setLngLat([lng, lat])
            .addTo(userMap);
        } else {
          userMarker.setLngLat([lng, lat]);
        }
      }
    },
    (error) => {
      gpsStatusText.textContent = "🔴 Error sa GPS: " + error.message;
      gpsStatusText.style.background = "#fde8e8";
      gpsStatusText.style.color = "#9b1c1c";
    },
    { enableHighAccuracy: true }
  );
}

document.getElementById("sosButton").addEventListener("click", () => {
  if (confirm("Sigurado ka bang magpapadala ng SOS Emergency Alert?")) {
    alert("Napadala na ang SOS Alert!");
  }
});

// ===== Admin menu =====
const descriptions = {
  "Dashboard": "System overview at monitoring summary.",
  "Live GPS Map": "Dito ipapakita ang mga live GPS location at pangalan ng lugar.",
  "Users / Accounts": "Pamamahala ng user accounts at profiles.",
  "Location History": "Mga naitalang lokasyon ng users.",
  "Playback": "Location playback ayon sa petsa at oras.",
  "Geofence": "Pamamahala ng authorized monitoring areas.",
  "Attendance": "Mga check-in at check-out record.",
  "Chat & Photos": "Communication center at photo messages.",
  "Announcements": "System announcements.",
  "SOS Alerts": "Mga emergency alert.",
  "Daily Reports": "Daily activity reports.",
  "Admin Settings": "System at administrator settings."
};

document.getElementById("menu").addEventListener("click", function (event) {
  const button = event.target.closest("button[data-page]");
  if (!button) return;

  document.querySelectorAll("#menu button").forEach(item => {
    item.classList.remove("active");
  });

  b