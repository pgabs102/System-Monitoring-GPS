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
    showAdminDashboard(profile);
  } else {
    await db.from("profiles").update({ is_online: true }).eq("id", user.id);
    showUserDashboard(profile, user);
    writeLocationLog(user.id, { event: "login" });
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

  userMap = new maplibregl.Map({
    container: "userMapContainer",
    style: "https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json",
    center: [120.9842, 14.5995],
    zoom: 14
  });

  userMap.addControl(new maplibregl.NavigationControl());
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

  button.classList.add("active");
  liveMap = null;
  stopLivePoll();

  const page = button.dataset.page;
  document.getElementById("pageTitle").textContent = page;
  document.getElementById("panelTitle").textContent = page;

  if (page === "Users / Accounts") {
    loadUsers();
  } else if (page === "Live GPS Map") {
    loadLiveMaplibre();
  } else if (page === "Geofence") {
    loadGeofencePanel();
  } else {
    document.getElementById("panelContent").textContent = descriptions[page] || "";
  }
});

async function initializeApp() {
  if (checkingSession) return;
  checkingSession = true;

  const { data, error } = await db.auth.getSession();

  if (error || !data.session) {
    showLogin();
    checkingSession = false;
    return;
  }

  await verifyAndRouteUser(data.session.user);
  checkingSession = false;
}

initializeApp();

async function fetchReverseGeocode(lat, lng) {
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}`);
    const data = await res.json();
    if (data && data.display_name) {
      return data.display_name;
    }
    return "Maynila, Pilipinas";
  } catch (e) {
    return "Kasalukuyang Lokasyon (Pilipinas)";
  }
}

// ===== Live GPS Map: popup =====
function buildLivePopup(user, lat, lng) {
  const wrap = document.createElement("div");
  wrap.style.cssText = "font-family:Arial,sans-serif;font-size:13px;line-height:1.5;min-width:230px;";

  const name = user.full_name || user.email || "User";
  const place = user.location_name || "Hindi pa alam ang lugar";
  const wazeUrl = `https://waze.com/ul?ll=${lat},${lng}&navigate=yes`;
  const gmapsUrl = `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
  const hasContact = !!user.contact;

  const iconBtn =
    "width:40px;height:40px;border-radius:50%;border:none;display:flex;align-items:center;" +
    "justify-content:center;font-size:18px;text-decoration:none;cursor:pointer;" +
    "box-shadow:0 1px 3px rgba(0,0,0,.3);padding:0;";

  wrap.innerHTML = `
    <strong style="font-size:14px;color:#1769aa;">${name}</strong><br>
    📍 <b class="pp-place" style="font-size:14px;">${place}</b><br>
    📊 <b>Status:</b> ${liveStatusBadge(user.is_online)}<br>
    🔋 <b>Battery:</b> ${batteryLabel(user)}<br>
    📞 <b>Contact:</b> ${user.contact || "Walang numero"}<br>

    <div style="margin-top:10px;display:flex;justify-content:space-around;align-items:center;">
      <a href="${wazeUrl}" target="_blank" title="Waze" style="${iconBtn}background:#33ccff;">🚗</a>
      ${hasContact
        ? `<a href="tel:${user.contact}" title="Tawag" style="${iconBtn}background:#137333;">📞</a>`
        : `<button type="button" title="Walang numero" disabled style="${iconBtn}background:#cbd5e1;cursor:not-allowed;">📞</button>`}
      <a href="${gmapsUrl}" target="_blank" title="Google Maps" style="${iconBtn}background:#ea4335;">🗺️</a>
      <button type="button" class="btn-chat" title="Chat" style="${iconBtn}background:#1769aa;color:#fff;">💬</button>
    </div>

    <div class="chat-box" style="display:none;margin-top:10px;">
      <textarea rows="2" placeholder="I-type ang mensahe..." style="width:100%;box-sizing:border-box;padding:6px;"></textarea>
      <button type="button" class="btn-send" style="margin-top:4px;width:100%;padding:6px;background:#1769aa;color:#fff;border:none;border-radius:4px;">📨 Ipadala</button>
      <div class="chat-status" style="font-size:12px;margin-top:4px;"></div>
    </div>
  `;

  const chatBtn = wrap.querySelector(".btn-chat");
  const chatBox = wrap.querySelector(".chat-box");
  const ta = wrap.querySelector("textarea");
  const sendBtn = wrap.querySelector(".btn-send");
  const st = wrap.querySelector(".chat-status");

  chatBtn.addEventListener("click", () => {
    const open = chatBox.style.display === "none";
    chatBox.style.display = open ? "block" : "none";
    if (open) ta.focus();
  });

  sendBtn.addEventListener("click", async () => {
    const body = ta.value.trim();
    if (!body) return;

    sendBtn.disabled = true;
    st.style.color = "#1769aa";
    st.textContent = "Ipinapadala...";

    const { data: auth } = await db.auth.getUser();
    const { error } = await db.from("messages").insert({
      from_id: auth.user.id,
      to_id: user.id,
      body
    });

    sendBtn.disabled = false;
    if (error) {
      st.style.color = "#b42318";
      st.textContent = "Error: " + error.message;
    } else {
      ta.value = "";
      st.style.color = "#137333";
      st.textContent = "Naipadala na ✅";
    }
  });

  return wrap;
}

// ===== Live GPS Map: markers =====
function buildMarkerEl() {
  const el = document.createElement("div");
  el.style.cssText = "display:flex;flex-direction:column;align-items:center;cursor:pointer;";

  el.innerHTML = `
    <div class="lm-label" style="background:#fff;border:1px solid #cbd5e1;border-radius:6px;
      padding:2px 6px;font:bold 11px Arial,sans-serif;color:#1e293b;white-space:nowrap;
      box-shadow:0 1px 3px rgba(0,0,0,.25);margin-bottom:4px;"></div>
    <div class="lm-pin" style="width:32px;height:32px;border-radius:50%;border:2px solid #fff;
      box-shadow:0 1px 4px rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;
      color:#fff;font:bold 15px Arial,sans-serif;"></div>
  `;
  return el;
}

function updateMarkerEl(el, user) {
  const label = el.querySelector(".lm-label");
  const pin = el.querySelector(".lm-pin");

  const fullName = user.full_name || "User";
  const initial = fullName.trim().charAt(0).toUpperCase();

  label.textContent = fullName + " · " + shortPlace(user.location_name);
  pin.textContent = initial;
  pin.style.background = user.is_online ? "#137333" : "#94a3b8";
}

function renderLiveUser(user) {
  const list = document.getElementById("liveUserList");
  if (!list || !liveMap || user.role === "admin") return;

  liveUserData[user.id] = user;

  let li = list.querySelector(`li[data-user-id="${user.id}"]`);
  if (!li) {
    li = document.createElement("li");
    li.dataset.userId = user.id;
    list.appendChild(li);
  }
  const name = user.full_name || user.email || "User";
  li.innerHTML = `<b>${name}</b> — 📞 ${user.contact || "Walang numero"} — Status: ${liveStatusBadge(user.is_online)} <span>🔋 ${batteryLabel(user)}</span> <span>📍 ${shortPlace(user.location_name)}</span>`;

  const lat = parseFloat(user.latitude);
  const lng = parseFloat(user.longitude);
  if (isNaN(lat) || isNaN(lng) || lat === 0 || lng === 0) return;

  const placeText = user.location_name || "Hindi pa alam ang lugar";
  const existing = liveMarkers[user.id];

  if (existing) {
    existing.marker.setLngLat([lng, lat]);
    updateMarkerEl(existing.marker.getElement(), user);

    const popup = existing.marker.getPopup();
    if (popup.isOpen()) {
      const placeEl = popup.getElement()?.querySelector(".pp-place");
      if (placeEl) placeEl.textContent = placeText;
    }
    return;
  }

  const el = buildMarkerEl();
  updateMarkerEl(el, user);

  const popup = new maplibregl.Popup({ offset: 25 }).setDOMContent(buildLivePopup(user, lat, lng));

  popup.on("open", () => {
    const u = liveUserData[user.id];
    if (!u) return;
    const uLat = parseFloat(u.latitude);
    const uLng = parseFloat(u.longitude);
    if (isNaN(uLat) || isNaN(uLng)) return;
    popup.setDOMContent(buildLivePopup(u, uLat, uLng));
  });

  const marker = new maplibregl.Marker({ element: el, anchor: "bottom" })
    .setLngLat([lng, lat])
    .setPopup(popup)
    .addTo(liveMap);

  liveMarkers[user.id] = { marker };
}

function stopLivePoll() {
  if (livePollTimer) {
    clearInterval(livePollTimer);
    livePollTimer = null;
  }
}

async function refreshLiveUsers() {
  if (!liveMap) {
    stopLivePoll();
    return;
  }

  const { data: users, error } = await db.from("profiles").select("*");
  if (error || !users) return;

  users.forEach(user => {
    if (user.role === "admin") return;
    renderLiveUser(user);
  });
}

async function loadLiveMaplibre() {
  const content = document.getElementById("panelContent");
  content.innerHTML = `
    <h3>Admin Live GPS Monitoring</h3>
    <div style="display: flex; flex-direction: column; gap: 15px;">
      <div id="mapContainer" style="width:100%; height:400px; border-radius:8px;"></div>
      <div id="adminUserListContainer" style="background: #f8fafc; padding: 12px; border-radius: 8px; border: 1px solid #e2e8f0;">
        <h4 style="margin-top: 0; font-size: 14px; color: #1e293b;">📋 Active Monitored Users</h4>
        <div id="monitoredUsersList">Loading active users...</div>
      </div>
    </div>
  `;

  liveMap = new maplibregl.Map({
    container: "mapContainer",
    style: "https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json",
    center: [120.9842, 14.5995],
    zoom: 11
  });
  liveMap.addControl(new maplibregl.NavigationControl());
  liveMarkers = {};
  liveUserData = {};

  const { data: users, error } = await db.from("profiles").select("*");

  const listDiv = document.getElementById("monitoredUsersList");
  if (!listDiv) return;

  if (error) {
    console.error("Supabase Error:", error);
    listDiv.textContent = "Database Error: " + error.message;
    return;
  }

  if (!users || users.length === 0) {
    listDiv.textContent = "Wala pang rehistradong user sa database.";
    return;
  }

  listDiv.innerHTML = "<ul id='liveUserList' style='margin: 0; padding-left: 18px; font-size: 13px; line-height: 1.6;'></ul>";

  const bounds = new maplibregl.LngLatBounds();
  let hasValidCoords = false;

  users.forEach(user => {
    if (user.role === "admin") return;
    renderLiveUser(user);

    const lat = parseFloat(user.latitude);
    const lng = parseFloat(user.longitude);
    if (!isNaN(lat) && !isNaN(lng) && lat !== 0 && lng !== 0) {
      hasValidCoords = true;
      bounds.extend([lng, lat]);
    }
  });

  if (hasValidCoords) {
    liveMap.fitBounds(bounds, { padding: 50, maxZoom: 15 });
  }

  stopLivePoll();
  livePollTimer = setInterval(refreshLiveUsers, 10000);
}

// ===== Users / Accounts =====
async function loadUsers() {
  const content = document.getElementById("panelContent");
  content.textContent = "Loading users...";

  const { data, error } = await db
    .from("profiles")
    .select("id, full_name, role, contact, location_sharing, is_online, created_at, battery_level, is_charging")
    .order("created_at", { ascending: false });

  if (error) {
    content.textContent = "Error loading users: " + error.message;
    return;
  }

  if (!data || data.length === 0) {
    content.textContent = "Wala pang registered users.";
    return;
  }

  const table = document.createElement("table");
  table.style.width = "100%";
  table.style.borderCollapse = "collapse";

  const header = document.createElement("tr");

  ["Name", "Role", "Contact", "Monitoring Status", "Battery", "Location Sharing", "Action"].forEach(label => {
    const th = document.createElement("th");
    th.textContent = label;
    th.style.padding = "10px";
    th.style.textAlign = "left";
    th.style.borderBottom = "1px solid #ddd";
    header.appendChild(th);
  });

  table.appendChild(header);

  data.forEach(user => {
    const row = document.createElement("tr");
    row.dataset.userId = user.id;

    const tdName = document.createElement("td");
    tdName.textContent = user.full_name ?? "—";
    tdName.style.padding = "10px";
    tdName.style.borderBottom = "1px solid #eee";
    row.appendChild(tdName);

    const tdRole = document.createElement("td");
    tdRole.textContent = user.role ?? "—";
    tdRole.style.padding = "10px";
    tdRole.style.borderBottom = "1px solid #eee";
    row.appendChild(tdRole);

    const tdContact = document.createElement("td");
    tdContact.textContent = user.contact ?? "—";
    tdContact.style.padding = "10px";
    tdContact.style.borderBottom = "1px solid #eee";
    row.appendChild(tdContact);

    const tdStatus = document.createElement("td");
    tdStatus.style.padding = "10px";
    tdStatus.style.borderBottom = "1px solid #eee";
    tdStatus.classList.add("status-cell");

    const badge = document.createElement("span");
    if (user.is_online) {
      badge.className = "badge-online";
      badge.textContent = "Online";
    } else {
      badge.className = "badge-offline";
      badge.textContent = "Offline";
    }
    tdStatus.appendChild(badge);
    row.appendChild(tdStatus);

    const tdBattery = document.createElement("td");
    tdBattery.style.padding = "10px";
    tdBattery.style.borderBottom = "1px solid #eee";
    tdBattery.classList.add("battery-cell");
    tdBattery.textContent = batteryLabel(user);
    row.appendChild(tdBattery);

    const tdSharing = document.createElement("td");
    tdSharing.textContent = user.location_sharing ? "Enabled" : "Disabled";
    tdSharing.style.padding = "10px";
    tdSharing.style.borderBottom = "1px solid #eee";
    row.appendChild(tdSharing);

    if (user.role === "user") {
      const actionCell = document.createElement("td");
      actionCell.style.padding = "10px";
      actionCell.style.borderBottom = "1px solid #eee";

      const btnContainer = document.createElement("div");
      btnContainer.style.display = "flex";
      btnContainer.style.gap = "6px";

      const deactivateButton = document.createElement("button");
      deactivateButton.textContent = "Deactivate";
      deactivateButton.style.background = "#b42318";
      deactivateButton.style.color = "white";
      deactivateButton.style.border = "none";
      deactivateButton.style.padding = "6px 10px";
      deactivateButton.style.borderRadius = "4px";

      deactivateButton.addEventListener("click", async () => {
        if (!confirm("Sigurado ka bang ide-deactivate ang account na ito?")) return;

        deactivateButton.disabled = true;
        deactivateButton.textContent = "Processing...";

        const { data: result, error } = await db.functions.invoke(
          "admin-deactivate-user",
          { body: { user_id: user.id } }
        );

        if (error || !result?.success) {
          alert(result?.error || error?.message || "Deactivation failed.");
          deactivateButton.disabled = false;
          deactivateButton.textContent = "Deactivate";
          return;
        }

        alert("User account deactivated.");
        loadUsers();
      });

      const reactivateButton = document.createElement("button");
      reactivateButton.textContent = "Reactivate";
      reactivateButton.style.background = "#2b7a78";
      reactivateButton.style.color = "white";
      reactivateButton.style.border = "none";
      reactivateButton.style.padding = "6px 10px";
      reactivateButton.style.borderRadius = "4px";

      reactivateButton.addEventListener("click", async () => {
        if (!confirm("Sigurado ka bang i-reactivate ang account na ito?")) return;

        reactivateButton.disabled = true;
        reactivateButton.textContent = "Processing...";

        const { data: result, error } = await db.functions.invoke(
          "admin-reactivate-user",
          { body: { user_id: user.id } }
        );

        if (error || !result?.success) {
          alert(result?.error || error?.message || "Reactivation failed.");
          reactivateButton.disabled = false;
          reactivateButton.textContent = "Reactivate";
          return;
        }

        alert("User account reactivated successfully.");
        loadUsers();
      });

      btnContainer.appendChild(deactivateButton);
      btnContainer.appendChild(reactivateButton);
      actionCell.appendChild(btnContainer);
      row.appendChild(actionCell);
    } else {
      const actionCell = document.createElement("td");
      actionCell.textContent = "—";
      actionCell.style.padding = "10px";
      actionCell.style.borderBottom = "1px solid #eee";
      row.appendChild(actionCell);
    }

    table.appendChild(row);
  });

  content.replaceChildren(table);
  showCreateUserForm();
}

async function showCreateUserForm() {
  const content = document.getElementById("panelContent");

  const form = document.createElement("form");
  form.style.marginBottom = "20px";

  form.innerHTML = `
    <h3>Create New User</h3>

    <input id="newUserName" type="text" placeholder="Full Name" required
      style="display:block;width:100%;padding:12px;margin:8px 0;">

    <input id="newUserEmail" type="email" placeholder="Email Address" required
      style="display:block;width:100%;padding:12px;margin:8px 0;">

    <input id="newUserContact" type="tel" placeholder="Contact Number (hal. 09171234567)" required
      style="display:block;width:100%;padding:12px;margin:8px 0;">

    <input id="newUserPassword" type="password" placeholder="Password (at least 8 characters)" minlength="8" required
      style="display:block;width:100%;padding:12px;margin:8px 0;">

    <button type="submit" style="padding:12px 20px;">Create User</button>

    <p id="createUserMessage"></p>
  `;

  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    const message = document.getElementById("createUserMessage");
    message.style.color = "#1769aa";
    message.textContent = "Creating account...";

    const full_name = document.getElementById("newUserName").value.trim();
    const email = document.getElementById("newUserEmail").value.trim();
    const contact = document.getElementById("newUserContact").value.trim();
    const password = document.getElementById("newUserPassword").value;

    const { data, error } = await db.functions.invoke("admin-create-user", {
      body: { full_name, email, contact, password },
    });

    if (error) {
      let msg = error.message;
      try {
        const j = await error.context.json();
        msg = j.error || msg;
      } catch (e) {}
      message.style.color = "#b42318";
      message.textContent = "Error: " + msg;
      return;
    }

    if (!data || !data.success) {
      message.style.color = "#b42318";
      message.textContent = data?.error || "Account creation failed.";
      return;
    }

    message.style.color = "#137333";
    message.textContent = "User account created successfully!";
    form.reset();
    loadUsers();
  });

  content.prepend(form);
}

// ===== Geofence =====
async function loadGeofencePanel() {
  const content = document.getElementById("panelContent");
  content.innerHTML = `
    <h3>Pamamahala ng Geofence Zone</h3>
    <p style="color:#64748b; font-size:13px;">I-click ang mapa sa ibaba para piliin ang lokasyon ng geofence zone, o i-type ang detalye.</p>

    <div class="geofence-form">
      <input id="geoName" type="text" placeholder="Pangalan ng Zone (Hal: Main Office / Terminal)" />

      <div style="display: flex; gap: 10px;">
        <input id="geoLat" type="number" step="any" placeholder="Latitude" style="flex:1;" />
        <input id="geoLng" type="number" step="any" placeholder="Longitude" style="flex:1;" />
      </div>

      <input id="geoRadius" type="number" placeholder="Radius sa Metro (Hal: 500)" value="500" />

      <p style="font-size:12px; font-weight:bold; margin:10px 0 5px 0; color:#173c60;">🗺️ Pindutin sa mapa para sa lokasyon:</p>
      <div id="geoPickerMap" style="width:100%; height:250px; border-radius:8px; border:1px solid #ccd5df; margin-bottom:10px;"></div>

      <button class="primary" id="saveGeofenceBtn" style="padding:10px;">I-save ang Geofence</button>
      <p id="geoMessage" style="font-size:13px; margin-top:10px; color:#1769aa;"></p>
    </div>

    <div id="geofenceList"></div>
  `;

  initGeoPickerMap();
  fetchGeofences();

  document.getElementById("saveGeofenceBtn").addEventListener("click", async () => {
    const name = document.getElementById("geoName").value.trim();
    const latitude = parseFloat(document.getElementById("geoLat").value);
    const longitude = parseFloat(document.getElementById("geoLng").value);
    const radius = parseFloat(document.getElementById("geoRadius").value);
    const msg = document.getElementById("geoMessage");

    if (!name || isNaN(latitude) || isNaN(longitude) || isNaN(radius)) {
      msg.style.color = "#b42318";
      msg.textContent = "Mangyaring punan nang tama ang lahat o i-click ang mapa.";
      return;
    }

    msg.style.color = "#1769aa";
    msg.textContent = "Sine-save ang geofence...";

    const { error } = await db.from("geofences").insert([{ name, latitude, longitude, radius }]);

    if (error) {
      msg.style.color = "#b42318";
      msg.textContent = "Error: " + error.message;
      return;
    }

    msg.style.color = "#137333";
    msg.textContent = "Matagumpay na na-save ang Geofence zone!";
    document.getElementById("geoName").value = "";
    document.getElementById("geoLat").value = "";
    document.getElementById("geoLng").value = "";
    document.getElementById("geoRadius").value = "500";

    fetchGeofences();
  });
}

let geoMap = null;
let geoMarker = null;

function initGeoPickerMap() {
  if (geoMap) return;

  geoMap = new maplibregl.Map({
    container: "geoPickerMap",
    style: "https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json",
    center: [120.9842, 14.5995],
    zoom: 12
  });

  geoMap.addControl(new maplibregl.NavigationControl());

  geoMap.on("load", () => {
    geoMap.addSource("geofence-radius", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] }
    });

    geoMap.addLayer({
      id: "geofence-circle-fill",
      type: "fill",
      source: "geofence-radius",
      paint: { "fill-color": "#1769aa", "fill-opacity": 0.25 }
    });

    geoMap.addLayer({
      id: "geofence-circle-border",
      type: "line",
      source: "geofence-radius",
      paint: { "line-color": "#1769aa", "line-width": 2 }
    });
  });

  geoMap.on("click", (e) => {
    const lng = e.lngLat.lng;
    const lat = e.lngLat.lat;

    document.getElementById("geoLat").value = lat.toFixed(6);
    document.getElementById("geoLng").value = lng.toFixed(6);

    if (!geoMarker) {
      geoMarker = new maplibregl.Marker({ color: "#b42318" })
        .setLngLat([lng, lat])
        .addTo(geoMap);
    } else {
      geoMarker.setLngLat([lng, lat]);
    }

    updateGeoCirclePreview(lng, lat);
  });
}

function updateGeoCirclePreview(lng, lat) {
  if (!geoMap || !geoMap.getSource("geofence-radius")) return;

  const radiusInMeters = parseFloat(document.getElementById("geoRadius").value) || 500;
  const points = 64;
  const coords = [];
  const km = radiusInMeters / 1000;

  for (let i = 0; i < points; i++) {
    const angle = (i * 360) / points;
    const dx = km * Math.cos((angle * Math.PI) / 180);
    const dy = km * Math.sin((angle * Math.PI) / 180);

    const latDelta = dy / 110.574;
    const lngDelta = dx / (111.320 * Math.cos((lat * Math.PI) / 180));

    coords.push([lng + lngDelta, lat + latDelta]);
  }
  coords.push(coords[0]);

  geoMap.getSource("geofence-radius").setData({
    type: "Feature",
    geometry: { type: "Polygon", coordinates: [coords] }
  });
}

async function fetchGeofences() {
  const listContainer = document.getElementById("geofenceList");
  if (!listContainer) return;

  const { data, error } = await db.from("geofences").select("*").order("created_at", { ascending: false });

  if (error || !data || data.length === 0) {
    listContainer.innerHTML = "<p style='font-size:13px; color:#64748b;'>Wala pang nakitang geofence zone.</p>";
    return;
  }

  let html = `<h4>Mga Naka-set na Geofence Zones:</h4><ul style="padding-left: 20px; font-size: 14px; line-height: 1.6;">`;

  for (const zone of data) {
    const placeName = await fetchReverseGeocode(zone.latitude, zone.longitude);

    html += `
      <li style="margin-bottom: 8px;">
        <b>${zone.name}</b><br>
        <span style="color:#64748b; font-size:13px;">📍 ${placeName}</span><br>
        <span style="font-size:12px; color:#1769aa;">(Radius: ${zone.radius}m)</span>
      </li>
    `;
  }

  html += `</ul>`;
  listContainer.innerHTML = html;
}
