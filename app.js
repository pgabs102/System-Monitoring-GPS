const SUPABASE_URL = "https://anidcxlmjiyrjsbvchrs.supabase.co";
const SUPABASE_KEY = "sb_publishable_An-AXhwWYFlFEZ4oxfK8qg_kuaW7rOI";

const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

// Hiwalay na client para sa paggawa ng bagong account nang hindi naka-logout ang admin
const signupDb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
});

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
let mapCenteredOnce = false;
let usersRefreshTimer = null;

let profilesChannel = null;
let liveMap = null;
let liveMarkers = {};
let liveUserData = {};
let livePollTimer = null;
let batteryTimer = null;
let batteryVisibilityHandler = null;

let adminSelfId = null;
let lastUserListMode = null;

let lastGeoLat = null;
let lastGeoLng = null;
let lastPlaceName = null;

const adminDashboardHtml = document.getElementById("panelContent").innerHTML;

// ===== Login / screen routing =====
function showLogin(message = "") {
  dashboardScreen.classList.add("hidden");
  userScreen.classList.add("hidden");
  loginScreen.classList.remove("hidden");
  loginMessage.textContent = message;
  loginButton.disabled = false;

  stopBatteryHeartbeat();
  stopLivePoll();
  stopInboxRealtime();
  stopUsersList();
  clearOtherUserMarkers();
  liveMap = null;
  stopAdminRealtime();
  stopOwnProfileWatch();
  stopAdminGps();

  if (watchPositionId !== null) {
    navigator.geolocation.clearWatch(watchPositionId);
    watchPositionId = null;
  }
}

// ===== Auto logout kapag na-deactivate habang naka-login =====
let ownProfileChannel = null;

function startOwnProfileWatch(userId) {
  stopOwnProfileWatch();

  ownProfileChannel = db
    .channel(`own-profile-${userId}`)
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "profiles", filter: `id=eq.${userId}` },
      async (payload) => {
        if (payload.new.is_active === false) {
          currentUserSessionId = null;
          stopOwnProfileWatch();
          await db.auth.signOut();
          showLogin("Na-deactivate ang account mo. Makipag-ugnayan sa admin.");
        }
      }
    )
    .subscribe();
}

function stopOwnProfileWatch() {
  if (ownProfileChannel) {
    db.removeChannel(ownProfileChannel);
    ownProfileChannel = null;
  }
}

function showAdminDashboard(profile) {
  loginScreen.classList.add("hidden");
  userScreen.classList.add("hidden");
  dashboardScreen.classList.remove("hidden");
  document.getElementById("welcomeText").textContent =
    "Welcome, " + profile.full_name + " (Admin)";

  startAdminRealtime();
  startAdminGps();
  showAdminPage("Dashboard");
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
  startUsersList(user.id);
  startOwnProfileWatch(user.id);
}

async function verifyAndRouteUser(user) {
  const { data: profile, error } = await db
    .from("profiles")
    .select("full_name, role, location_sharing, is_active")
    .eq("id", user.id)
    .maybeSingle();

  if (error || !profile) {
    console.error("Profile error:", error);
    await db.auth.signOut();
    showLogin("Hindi nahanap ang profile access" + (error ? ": " + error.message : " (walang profile row)"));
    return false;
  }

  if (profile.is_active === false) {
    await db.auth.signOut();
    showLogin("Na-deactivate ang account mo. Makipag-ugnayan sa admin.");
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
  loginForm.reset();
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

function handleProfileUpdate(oldRow, newRow) {
  const page = document.querySelector("#menu button.active")?.dataset.page;
  if (page === "Live GPS Map" && liveMap) {
    renderLiveUser(newRow);
  } else if (page === "Users / Accounts" || page === "Location History" || page === "Chat & Photos") {
    if (!document.getElementById("adminUsersLoaded")) return;
    const mode = lastUserListMode || "users";
    renderUserList(mode);
  }
}

// ===== Helpers =====
function batteryLabel(user) {
  return user.battery_level != null
    ? `${user.battery_level}%${user.is_charging ? " ⚡" : ""}`
    : "N/A";
}

function shortPlace(name) {
  if (!name) return "Hindi pa alam ang lugar";
  return name.split(",").slice(0, 2).join(",").trim();
}

function isReallyOnline(p) {
  if (!p.is_online || !p.last_seen) return false;
  return Date.now() - new Date(p.last_seen).getTime() < 90000;
}

function timeAgo(iso) {
  if (!iso) return "Hindi pa alam";
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "Ngayon lang";
  if (mins < 60) return `${mins} min ang nakalipas`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} oras ang nakalipas`;
  return new Date(iso).toLocaleDateString("fil-PH", { month: "short", day: "numeric" });
}

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

function telLink(phone) {
  return `<a href="tel:${escapeHtml(String(phone).replace(/\s/g, ""))}" style="color:#1769aa;">${escapeHtml(phone)}</a>`;
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
  addRecenterButton();
  addUserPlaceToggle();
}

function addUserPlaceToggle() {
  const container = document.getElementById("userMapContainer");
  if (!container || document.getElementById("userPlaceToggleBtn")) return;

  const btn = document.createElement("button");
  btn.id = "userPlaceToggleBtn";
  btn.type = "button";
  btn.textContent = showPlaceLabels ? "🏷️ Lugar: ON" : "🏷️ Lugar: OFF";
  btn.style.cssText =
    "margin-top:8px;margin-left:6px;padding:6px 10px;background:#1769aa;color:#fff;" +
    "border:none;border-radius:6px;font-size:13px;";
  btn.onclick = () => {
    togglePlaceLabels();
    btn.textContent = showPlaceLabels ? "🏷️ Lugar: ON" : "🏷️ Lugar: OFF";
  };
  container.insertAdjacentElement("afterend", btn);
}

// ===== Chat =====
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
  }
}

// ===== GPS tracking =====
function distanceMeters(lat1, lng1, lat2, lng2) {
  const dLat = (lat2 - lat1) * 111000;
  const dLng = (lng2 - lng1) * 111000 * Math.cos((lat1 * Math.PI) / 180);
  return Math.sqrt(dLat * dLat + dLng * dLng);
}

function startUserTracking(userId) {
  mapCenteredOnce = false;

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
        distanceMeters(lastGeoLat, lastGeoLng, lat, lng) > 50;

      if (moved) {
        lastGeoLat = lat;
        lastGeoLng = lng;
        lastPlaceName = await fetchReverseGeocode(lat, lng);
        userLocationName.textContent = lastPlaceName || "Hindi pa alam ang lugar";
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
        if (!mapCenteredOnce) {
          userMap.setCenter([lng, lat]);
          mapCenteredOnce = true;
        }
        if (!userMarker) {
          const selfEl = document.createElement("div");
          selfEl.style.cssText = "width:18px;height:18px;border-radius:50%;background:#1769aa;border:3px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.35);position:relative;";
          selfEl.innerHTML = '<span class="place-label"></span>';
          userMarker = new maplibregl.Marker({ element: selfEl })
            .setLngLat([lng, lat])
            .addTo(userMap);
        } else {
          userMarker.setLngLat([lng, lat]);
        }
        const selfLabel = userMarker.getElement().querySelector(".place-label");
        if (selfLabel) selfLabel.textContent = shortPlace(lastPlaceName);
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

// ===== Button para bumalik sa posisyon mo =====
function addRecenterButton() {
  const container = document.getElementById("userMapContainer");
  if (!container || document.getElementById("recenterBtn")) return;

  const btn = document.createElement("button");
  btn.id = "recenterBtn";
  btn.type = "button";
  btn.textContent = "📍 Center sa akin";
  btn.style.cssText =
    "margin-top:8px;padding:6px 10px;background:#1769aa;color:#fff;" +
    "border:none;border-radius:6px;font-size:13px;";

  btn.onclick = () => {
    if (userMarker) {
      userMap.flyTo({ center: userMarker.getLngLat(), zoom: 15 });
    }
  };

  container.insertAdjacentElement("afterend", btn);
}

// ===== Listahan ng user (para sa kapwa user) =====
let usersChannel = null;
let usersPollTimer = null;
let usersMyId = null;
let otherUserMarkers = {};

async function loadAllUsers(myId) {
  const box = document.getElementById("usersListBody");
  if (!box) return;

  const { data, error } = await db
    .from("profiles")
    .select("id, full_name, role, is_online, last_seen, battery_level, is_charging, location_name, latitude, longitude")
    .neq("id", myId)
    .neq("role", "admin")
    .order("full_name", { ascending: true });

  if (error) {
    console.error("Users list error:", error);
    box.innerHTML = "<div style='padding:10px;color:#b42318;font-size:13px;'>Hindi maload ang listahan.</div>";
    return;
  }

  renderOtherUserMarkers(data || []);

  if (!data || data.length === 0) {
    box.innerHTML = "<div style='padding:10px;color:#64748b;font-size:13px;'>Walang ibang user.</div>";
    return;
  }

  box.innerHTML = data.map((p) => {
    const online = isReallyOnline(p);
    const dot = online ? "🟢" : "⚪";
    const status = online ? "Online" : "Offline · " + timeAgo(p.last_seen);
    const place = p.location_name ? shortPlace(p.location_name) : "Walang lokasyon";
    const name = escapeHtml(p.full_name || "User");
    const hasCoords = p.latitude != null && p.longitude != null;
    const disabled = hasCoords ? "" : "disabled";
    const btnStyle = "padding:5px 8px;border:none;border-radius:6px;font-size:12px;color:#fff;white-space:nowrap;";

    return `
      <div style="padding:10px;border-bottom:1px solid #e2e8f0;">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
          <div style="min-width:0;flex:1;">
            <div style="font-weight:600;color:#1e293b;">${dot} ${name}</div>
            <div style="font-size:12px;color:#64748b;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(place)}</div>
            <div style="font-size:12px;color:${online ? "#137333" : "#64748b"};margin-top:2px;">
              ${escapeHtml(status)} · 🔋 ${escapeHtml(batteryLabel(p))}
            </div>
          </div>
          <button class="user-chat-btn" data-act="chat" data-uid="${escapeHtml(p.id)}" data-name="${name}" type="button"
            style="${btnStyle}background:#1769aa;padding:6px 10px;">💬 Chat</button>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;">
          <button type="button" data-act="route" ${disabled}
            data-lat="${p.latitude ?? ""}" data-lng="${p.longitude ?? ""}" data-name="${name}"
            style="${btnStyle}background:#0f766e;">🧭 Ruta sa mapa</button>
          <button type="button" data-act="gmap" ${disabled}
            data-lat="${p.latitude ?? ""}" data-lng="${p.longitude ?? ""}" data-name="${name}"
            style="${btnStyle}background:#4285f4;">Google Maps</button>
          <button type="button" data-act="waze" ${disabled}
            data-lat="${p.latitude ?? ""}" data-lng="${p.longitude ?? ""}" data-name="${name}"
            style="${btnStyle}background:#33ccff;color:#0b1f2a;">Waze</button>
        </div>
      </div>
    `;
  }).join("");
}

function startUsersList(myId) {
  stopUsersList();
  usersMyId = myId;

  const old = document.getElementById("usersBox");
  if (old) old.remove();

  const card = document.querySelector("#userScreen .card");
  const sos = document.getElementById("sosButton");

  const box = document.createElement("div");
  box.id = "usersBox";
  box.style.cssText = "margin-top:15px;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;background:#fff;";
  box.innerHTML = `
    <div style="padding:8px 10px;background:#1769aa;color:#fff;font-weight:bold;">👥 Mga User</div>
    <div id="usersListBody"><div style="padding:10px;color:#64748b;font-size:13px;">Naglo-load...</div></div>
  `;
  card.insertBefore(box, sos);

  document.getElementById("usersListBody").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn || btn.disabled) return;

    const act = btn.dataset.act;
    const lat = parseFloat(btn.dataset.lat);
    const lng = parseFloat(btn.dataset.lng);
    const name = btn.dataset.name;

    if (act === "chat") openUserChat(btn.dataset.uid, name);
    else if (act === "route") showRouteOnMap(lng, lat, name);
    else if (act === "gmap") openGoogleMaps(lat, lng);
    else if (act === "waze") openWaze(lat, lng);
  });

  loadAllUsers(myId);

  usersChannel = db
    .channel(`users-list-${myId}`)
    .on("postgres_changes", { event: "*", schema: "public", table: "profiles" }, () => {
      clearTimeout(usersRefreshTimer);
      usersRefreshTimer = setTimeout(() => loadAllUsers(myId), 1500);
    })
    .subscribe();

  usersPollTimer = setInterval(() => loadAllUsers(myId), 30000);
}

function stopUsersList() {
  if (usersChannel) {
    db.removeChannel(usersChannel);
    usersChannel = null;
  }
  if (usersPollTimer) {
    clearInterval(usersPollTimer);
    usersPollTimer = null;
  }
  clearTimeout(usersRefreshTimer);
  clearOtherUserMarkers();
}

// ===== Markers ng ibang user sa mapa =====
function makeInitialMarkerEl(name, online) {
  const el = document.createElement("div");
  const initial = Array.from((name || "U").trim())[0] || "U";
  el.textContent = initial.toUpperCase();
  el.title = name || "User";
  el.style.cssText =
    "width:26px;height:26px;border-radius:50%;" +
    "background:" + (online ? "#137333" : "#94a3b8") + ";" +
    "color:#fff;font-size:12px;font-weight:bold;font-family:sans-serif;" +
    "display:flex;align-items:center;justify-content:center;" +
    "border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.35);cursor:pointer;";
  return el;
}

function renderOtherUserMarkers(rows) {
  if (!userMap || typeof maplibregl === "undefined") return;

  const seenIds = new Set();

  rows.forEach((p) => {
    if (p.latitude == null || p.longitude == null) return;

    seenIds.add(p.id);
    const online = isReallyOnline(p);
    const lngLat = [p.longitude, p.latitude];
    const label = `${p.full_name || "User"} · ${online ? "Online" : "Offline"} · ${shortPlace(p.location_name)}`;
    const existing = otherUserMarkers[p.id];

    if (existing) {
      existing.setLngLat(lngLat);
      const el = existing.getElement();
      el.style.background = online ? "#137333" : "#94a3b8";
      el.textContent = (Array.from((p.full_name || "U").trim())[0] || "U").toUpperCase();
      el.title = p.full_name || "User";
      existing.getPopup().setText(label);
      let lbl = el.querySelector(".place-label");
      if (!lbl) {
        lbl = document.createElement("span");
        lbl.className = "place-label";
        el.appendChild(lbl);
      }
      lbl.textContent = shortPlace(p.location_name);
    } else {
      const el = makeInitialMarkerEl(p.full_name, online);
      const lbl = document.createElement("span");
      lbl.className = "place-label";
      lbl.textContent = shortPlace(p.location_name);
      el.appendChild(lbl);
      const popup = new maplibregl.Popup({ offset: 16 }).setText(label);
      otherUserMarkers[p.id] = new maplibregl.Marker({ element: el })
        .setLngLat(lngLat)
        .setPopup(popup)
        .addTo(userMap);
    }
  });

  Object.keys(otherUserMarkers).forEach((id) => {
    if (!seenIds.has(id)) {
      otherUserMarkers[id].remove();
      delete otherUserMarkers[id];
    }
  });
}

function clearOtherUserMarkers() {
  Object.values(otherUserMarkers).forEach((m) => m.remove());
  otherUserMarkers = {};
}

// ===== Chat sa kapwa user =====
async function openUserChat(otherId, name) {
  const inbox = document.getElementById("chatBox");
  if (inbox) inbox.style.display = "none";

  const box = document.getElementById("usersBox");
  let panel = document.getElementById("userChatPanel");
  if (!panel) {
    panel = document.createElement("div");
    panel.id = "userChatPanel";
    box.appendChild(panel);
  }

  panel.style.display = "block";
  panel.innerHTML = `
    <div style="padding:8px 10px;background:#0f5a8f;color:#fff;font-weight:bold;display:flex;justify-content:space-between;align-items:center;">
      <span>💬 ${escapeHtml(name)}</span>
      <button id="userChatClose" type="button" style="background:#fff;color:#1769aa;border:none;border-radius:4px;padding:2px 8px;">✕</button>
    </div>
    <div id="userChatBody"></div>
  `;
  panel.querySelector("#userChatClose").onclick = closeUserChat;

  await mountChat(document.getElementById("userChatBody"), "pc", "", 260, usersMyId, otherId);
  panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function closeUserChat() {
  destroyActiveChat();

  const panel = document.getElementById("userChatPanel");
  if (panel) panel.style.display = "none";

  startInboxRealtime(usersMyId);
}

// ===== Navigation: Google Maps, Waze, at ruta sa mapa =====
const ROUTE_SRC = "route-src";
const ROUTE_LAYER = "route-line";
let routeDestMarker = null;

function getMyLngLat() {
  if (userMarker) return userMarker.getLngLat();
  if (lastGeoLat != null && lastGeoLng != null) return { lng: lastGeoLng, lat: lastGeoLat };
  return null;
}

function openGoogleMaps(lat, lng) {
  const me = getMyLngLat();
  const origin = me ? `&origin=${me.lat},${me.lng}` : "";
  window.open(
    `https://www.google.com/maps/dir/?api=1${origin}&destination=${lat},${lng}&travelmode=driving`,
    "_blank"
  );
}

function openWaze(lat, lng) {
  window.open(`https://www.waze.com/ul?ll=${lat},${lng}&navigate=yes`, "_blank");
}

async function showRouteOnMap(toLng, toLat, name) {
  if (!userMap) return alert("Hindi pa handa ang mapa.");
  if (isNaN(toLng) || isNaN(toLat)) return alert("Walang lokasyon ang user na ito.");

  const me = getMyLngLat();
  if (!me) return alert("Hindi pa alam ang lokasyon mo. Hintayin ang GPS.");

  let coords = [[me.lng, me.lat], [toLng, toLat]];
  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${me.lng},${me.lat};${toLng},${toLat}?overview=full&geometries=geojson`;
    const res = await fetch(url);
    const json = await res.json();
    if (json.code === "Ok" && json.routes && json.routes[0]) {
      coords = json.routes[0].geometry.coordinates;
    }
  } catch (e) {
    console.warn("Hindi ma-reach ang routing service, straight line ang gagamitin.", e);
  }

  if (!userMap.isStyleLoaded()) {
    await new Promise((resolve) => userMap.once("load", resolve));
  }

  const geojson = { type: "Feature", geometry: { type: "LineString", coordinates: coords } };

  if (userMap.getSource(ROUTE_SRC)) {
    userMap.getSource(ROUTE_SRC).setData(geojson);
  } else {
    userMap.addSource(ROUTE_SRC, { type: "geojson", data: geojson });
    userMap.addLayer({
      id: ROUTE_LAYER,
      type: "line",
      source: ROUTE_SRC,
      layout: { "line-join": "round", "line-cap": "round" },
      paint: { "line-color": "#1769aa", "line-width": 5, "line-opacity": 0.85 }
    });
  }

  if (routeDestMarker) routeDestMarker.remove();
  routeDestMarker = new maplibregl.Marker({ color: "#dc2626" })
    .setLngLat([toLng, toLat])
    .setPopup(new maplibregl.Popup({ offset: 16 }).setText("Patutungo: " + name))
    .addTo(userMap);

  const bounds = new maplibregl.LngLatBounds();
  coords.forEach((c) => bounds.extend(c));
  userMap.fitBounds(bounds, { padding: 60, maxZoom: 16 });

  ensureClearRouteButton();
}

function clearRoute() {
  if (!userMap) return;
  if (userMap.getLayer(ROUTE_LAYER)) userMap.removeLayer(ROUTE_LAYER);
  if (userMap.getSource(ROUTE_SRC)) userMap.removeSource(ROUTE_SRC);
  if (routeDestMarker) {
    routeDestMarker.remove();
    routeDestMarker = null;
  }
  const btn = document.getElementById("clearRouteBtn");
  if (btn) btn.remove();
}

function ensureClearRouteButton() {
  if (document.getElementById("clearRouteBtn")) return;
  const anchor = document.getElementById("recenterBtn");
  if (!anchor) return;

  const btn = document.createElement("button");
  btn.id = "clearRouteBtn";
  btn.type = "button";
  btn.textContent = "✕ Alisin ruta";
  btn.style.cssText =
    "margin-top:8px;margin-left:6px;padding:6px 10px;background:#64748b;color:#fff;" +
    "border:none;border-radius:6px;font-size:13px;";
  btn.onclick = clearRoute;
  anchor.insertAdjacentElement("afterend", btn);
}

// ===== Admin: pangkalahatang helpers =====
function stopLivePoll() {
  if (livePollTimer) {
    clearInterval(livePollTimer);
    livePollTimer = null;
  }
}

async function fetchReverseGeocode(lat, lng) {
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=json&zoom=18&lat=${lat}&lon=${lng}`,
      { headers: { "Accept-Language": "fil,en" } }
    );
    const data = await res.json();
    if (!data.display_name) return null;
    const short = data.display_name.split(",").slice(0, 2).join(",").trim();
    return data.name ? data.name + ", " + short : data.display_name;
  } catch (e) {
    console.error("Reverse geocode error:", e);
    return null;
  }
}

// ===== Admin: GPS ng admin (para sa ruta) =====
let adminGpsWatchId = null;

function startAdminGps() {
  stopAdminGps();
  if (!("geolocation" in navigator)) return;

  adminGpsWatchId = navigator.geolocation.watchPosition(
    (position) => {
      lastGeoLat = position.coords.latitude;
      lastGeoLng = position.coords.longitude;
    },
    (error) => {
      console.warn("Admin GPS error:", error.message);
    },
    { enableHighAccuracy: true }
  );
}

function stopAdminGps() {
  if (adminGpsWatchId !== null) {
    navigator.geolocation.clearWatch(adminGpsWatchId);
    adminGpsWatchId = null;
  }
}

// ===== Admin: ruta sa mapa =====
let adminRouteSrc = "admin-route-src";
let adminRouteLayer = "admin-route-line";
let adminRouteMarker = null;

function clearAdminRoute() {
  if (!liveMap) return;
  if (liveMap.getLayer(adminRouteLayer)) liveMap.removeLayer(adminRouteLayer);
  if (liveMap.getSource(adminRouteSrc)) liveMap.removeSource(adminRouteSrc);
  if (adminRouteMarker) {
    adminRouteMarker.remove();
    adminRouteMarker = null;
  }
  const btn = document.getElementById("adminClearRouteBtn");
  if (btn) btn.remove();
}

function ensureAdminClearRouteButton() {
  if (document.getElementById("adminClearRouteBtn")) return;
  const container = document.getElementById("liveMapContainer");
  if (!container) return;

  const btn = document.createElement("button");
  btn.id = "adminClearRouteBtn";
  btn.type = "button";
  btn.textContent = "✕ Alisin ruta";
  btn.style.cssText =
    "margin-top:8px;margin-right:6px;padding:6px 10px;background:#64748b;color:#fff;" +
    "border:none;border-radius:6px;font-size:13px;";
  btn.onclick = clearAdminRoute;
  container.insertAdjacentElement("afterend", btn);
}

async function showAdminRouteOnMap(toLat, toLng, name) {
  if (!liveMap) return alert("Hindi pa handa ang mapa. Buksan muna ang Live GPS Map.");
  if (isNaN(toLat) || isNaN(toLng)) return alert("Walang lokasyon ang user na ito.");

  // Ruta mula sa admin papunta sa user: gamitin ang lokasyon ng admin kung meron
  const me = getMyLngLat();
  if (!me) return alert("Hindi pa alam ang lokasyon mo. Hintayin ang GPS sa user page o buksan ang admin GPS.");

  let coords = [[me.lng, me.lat], [toLng, toLat]];
  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${me.lng},${me.lat};${toLng},${toLat}?overview=full&geometries=geojson`;
    const res = await fetch(url);
    const json = await res.json();
    if (json.code === "Ok" && json.routes && json.routes[0]) {
      coords = json.routes[0].geometry.coordinates;
    }
  } catch (e) {
    console.warn("Hindi ma-reach ang routing service, straight line ang gagamitin.", e);
  }

  if (!liveMap.isStyleLoaded()) {
    await new Promise((resolve) => liveMap.once("load", resolve));
  }

  const geojson = { type: "Feature", geometry: { type: "LineString", coordinates: coords } };

  if (liveMap.getSource(adminRouteSrc)) {
    liveMap.getSource(adminRouteSrc).setData(geojson);
  } else {
    liveMap.addSource(adminRouteSrc, { type: "geojson", data: geojson });
    liveMap.addLayer({
      id: adminRouteLayer,
      type: "line",
      source: adminRouteSrc,
      layout: { "line-join": "round", "line-cap": "round" },
      paint: { "line-color": "#1769aa", "line-width": 5, "line-opacity": 0.85 }
    });
  }

  if (adminRouteMarker) adminRouteMarker.remove();
  adminRouteMarker = new maplibregl.Marker({ color: "#dc2626" })
    .setLngLat([toLng, toLat])
    .setPopup(new maplibregl.Popup({ offset: 16 }).setText("Patutungo: " + name))
    .addTo(liveMap);

  const bounds = new maplibregl.LngLatBounds();
  coords.forEach((c) => bounds.extend(c));
  liveMap.fitBounds(bounds, { padding: 60, maxZoom: 16 });

  ensureAdminClearRouteButton();
}

// ===== Toggle ng pangalan ng lugar sa mapa =====
let showPlaceLabels = true;

const placeLabelStyle = document.createElement("style");
placeLabelStyle.textContent = `
  .place-label {
    position: absolute; left: 32px; top: 2px; white-space: nowrap;
    background: #fff; color: #1e293b; font: 600 11px Arial, sans-serif;
    padding: 2px 6px; border-radius: 6px; box-shadow: 0 1px 3px rgba(0,0,0,.3);
    pointer-events: none;
  }
  .hide-place-labels .place-label { display: none; }
`;
document.head.appendChild(placeLabelStyle);

function togglePlaceLabels() {
  showPlaceLabels = !showPlaceLabels;
  document.body.classList.toggle("hide-place-labels", !showPlaceLabels);
  const btn = document.getElementById("togglePlaceBtn");
  if (btn) btn.textContent = showPlaceLabels ? "🏷️ Lugar: ON" : "🏷️ Lugar: OFF";
}

// ===== Admin: Live GPS Map =====

function initLiveMap() {
  if (liveMap || typeof maplibregl === "undefined") return;

  liveMap = new maplibregl.Map({
    container: "liveMapContainer",
    style: "https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json",
    center: [120.9842, 14.5995],
    zoom: 12
  });

  liveMap.addControl(new maplibregl.NavigationControl());
}

function renderLiveMapPage() {
  setAdminContent(`
    <button type="button" id="togglePlaceBtn" style="margin-bottom:8px;padding:6px 10px;border:none;border-radius:6px;background:#1769aa;color:#fff;font-size:13px;">${showPlaceLabels ? "🏷️ Lugar: ON" : "🏷️ Lugar: OFF"}</button>
    <div id="liveMapContainer" style="height:450px;border-radius:8px;"></div>
    <div id="adminLiveList" style="margin-top:12px;"></div>
    <div id="liveChatPanel" style="margin-top:12px;"></div>
  `);
  document.getElementById("togglePlaceBtn").addEventListener("click", togglePlaceLabels);
  document.body.classList.toggle("hide-place-labels", !showPlaceLabels);
  initLiveMap();
  loadLiveUsers();
  livePollTimer = setInterval(loadLiveUsers, 30000);
}

async function loadLiveUsers() {
  const { data, error } = await db
    .from("profiles")
    .select("id, full_name, phone, latitude, longitude, location_name, is_online, last_seen, battery_level, is_charging, location_sharing, role")
    .neq("role", "admin");

  if (error) {
    console.error("Live users error:", error);
    return;
  }

  const rows = data || [];
  const ids = new Set(rows.map((r) => r.id));

  Object.keys(liveMarkers).forEach((id) => {
    if (!ids.has(id)) {
      liveMarkers[id].marker.remove();
      delete liveMarkers[id];
    }
  });

  rows.forEach((r) => renderLiveUser(r));
  renderAdminLiveList(rows);
}

function buildLiveAdminPopup(uid) {
  const wrap = document.createElement("div");
  wrap.style.cssText = "font-family:Arial,sans-serif;font-size:13px;line-height:1.5;min-width:220px;";
  const btnBase = "padding:6px 10px;border:none;border-radius:6px;color:#fff;font-size:12px;";

  wrap.innerHTML = `
    <strong class="lp-name" style="font-size:14px;color:#1769aa;"></strong><br>
    <span class="lp-status"></span><br>
    <span class="lp-phone"></span><br>
    <span class="lp-batt"></span><br>
    <span class="lp-place"></span><br>
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px;">
      <button type="button" class="lp-chat" style="${btnBase}background:#1769aa;">💬 Chat</button>
      <button type="button" class="lp-gmap" style="${btnBase}background:#4285f4;">Google Maps</button>
      <button type="button" class="lp-waze" style="${btnBase}background:#33ccff;color:#0b1f2a;">Waze</button>
      <button type="button" class="lp-route" style="${btnBase}background:#0f766e;">🧭 Ruta</button>
    </div>
  `;

  wrap.querySelector(".lp-chat").onclick = () => openLiveChat(uid);
  wrap.querySelector(".lp-gmap").onclick = () => {
    const u = liveUserData[uid];
    if (u && u.latitude != null) openGoogleMaps(u.latitude, u.longitude);
  };
  wrap.querySelector(".lp-waze").onclick = () => {
    const u = liveUserData[uid];
    if (u && u.latitude != null) openWaze(u.latitude, u.longitude);
  };
  wrap.querySelector(".lp-route").onclick = () => {
    const u = liveUserData[uid];
    if (u && u.latitude != null) showAdminRouteOnMap(u.latitude, u.longitude, u.full_name || "User");
  };

  return wrap;
}

function renderLiveUser(row) {
  if (!liveMap || row.latitude == null || row.longitude == null) return;

  liveUserData[row.id] = row;
  const lngLat = [row.longitude, row.latitude];
  const online = isReallyOnline(row);
  const name = row.full_name || "User";

  if (!liveMarkers[row.id]) {
    const content = buildLiveAdminPopup(row.id);
    const popup = new maplibregl.Popup({ offset: 16 }).setDOMContent(content);
    const marker = new maplibregl.Marker({ element: makeInitialMarkerEl(name, online) })
      .setLngLat(lngLat)
      .setPopup(popup)
      .addTo(liveMap);
    liveMarkers[row.id] = { marker, content };
  }

  const { marker, content } = liveMarkers[row.id];
  marker.setLngLat(lngLat);

  const el = marker.getElement();
  el.style.background = online ? "#137333" : "#94a3b8";
  el.textContent = (Array.from(name.trim())[0] || "U").toUpperCase();
  el.title = name;

  let label = el.querySelector(".place-label");
  if (!label) {
    label = document.createElement("span");
    label.className = "place-label";
    el.appendChild(label);
  }
  label.textContent = shortPlace(row.location_name);

  content.querySelector(".lp-name").textContent = name;
  content.querySelector(".lp-status").innerHTML = online
    ? '<span style="color:#137333;font-weight:bold;">🟢 Online</span>'
    : '<span style="color:#64748b;">⚪ Offline · ' + escapeHtml(timeAgo(row.last_seen)) + '</span>';
  content.querySelector(".lp-phone").innerHTML = row.phone
    ? "📞 " + telLink(row.phone)
    : "📞 Walang numero";
  content.querySelector(".lp-batt").textContent = "🔋 Baterya: " + batteryLabel(row);
  content.querySelector(".lp-place").textContent = "📍 " + shortPlace(row.location_name);
}

function renderAdminLiveList(rows) {
  const box = document.getElementById("adminLiveList");
  if (!box) return;

  if (!rows.length) {
    box.innerHTML = "<div style='color:#64748b;font-size:13px;'>Walang user.</div>";
    return;
  }

  const btn = "padding:6px 10px;border:none;border-radius:6px;color:#fff;font-size:13px;margin:2px;";
  const body = rows.map((p) => {
    const online = isReallyOnline(p);
    const name = escapeHtml(p.full_name || "User");
    const hasCoords = p.latitude != null && p.longitude != null;
    const disabled = hasCoords ? "" : "disabled";
    const lat = hasCoords ? p.latitude : "";
    const lng = hasCoords ? p.longitude : "";
    const phoneCell = p.phone ? telLink(p.phone) : "—";

    return `
      <tr style="border-bottom:1px solid #e2e8f0;">
        <td style="padding:8px;">${name}</td>
        <td style="padding:8px;">${phoneCell}</td>
        <td style="padding:8px;color:${online ? "#137333" : "#64748b"};">${online ? "🟢 Online" : "⚪ Offline"}</td>
        <td style="padding:8px;">${escapeHtml(batteryLabel(p))}</td>
        <td style="padding:8px;">${escapeHtml(p.location_name ? shortPlace(p.location_name) : "—")}</td>
        <td style="padding:8px;white-space:nowrap;">
          <button type="button" data-act="live-chat" data-uid="${escapeHtml(p.id)}" style="${btn}background:#1769aa;">💬 Chat</button>
          <button type="button" data-act="nav-gmap" data-lat="${lat}" data-lng="${lng}" ${disabled} style="${btn}background:#4285f4;">Google Maps</button>
          <button type="button" data-act="nav-waze" data-lat="${lat}" data-lng="${lng}" ${disabled} style="${btn}background:#33ccff;color:#0b1f2a;">Waze</button>
          <button type="button" data-act="nav-route" data-lat="${lat}" data-lng="${lng}" data-name="${name}" ${disabled} style="${btn}background:#0f766e;">🧭 Ruta</button>
        </td>
      </tr>`;
  }).join("");

  box.innerHTML = `
    <div style="overflow-x:auto;">
      <table style="width:100%;border-collapse:collapse;font-size:14px;">
        <thead>
          <tr style="text-align:left;border-bottom:2px solid #e2e8f0;">
            <th style="padding:8px;">Pangalan</th>
            <th style="padding:8px;">Telepono</th>
            <th style="padding:8px;">Status</th>
            <th style="padding:8px;">Baterya</th>
            <th style="padding:8px;">Lugar</th>
            <th style="padding:8px;">Aksyon</th>
          </tr>
        </thead>
        <tbody>${body}</tbody>
      </table>
    </div>
  `;
}

async function openLiveChat(uid) {
  const panel = document.getElementById("liveChatPanel");
  if (!panel) return;

  const u = liveUserData[uid];
  const name = u ? (u.full_name || "User") : "User";

  panel.innerHTML = `
    <div style="padding:8px 10px;background:#1769aa;color:#fff;font-weight:bold;display:flex;justify-content:space-between;align-items:center;border-radius:8px 8px 0 0;">
      <span>💬 ${escapeHtml(name)}</span>
      <button id="liveChatClose" type="button" style="background:#fff;color:#1769aa;border:none;border-radius:4px;padding:2px 8px;">✕</button>
    </div>
    <div id="liveChatBody" style="border:1px solid #e2e8f0;border-top:none;border-radius:0 0 8px 8px;overflow:hidden;background:#fff;"></div>
  `;

  panel.querySelector("#liveChatClose").onclick = () => {
    destroyActiveChat();
    panel.innerHTML = "";
  };

  const myId = adminSelfId || (await getCurrentUserId());
  await mountChat(document.getElementById("liveChatBody"), "lc", "", 260, myId, uid);
  panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// ===== Admin: pages =====
function setAdminContent(html) {
  destroyActiveChat();
  document.getElementById("panelContent").innerHTML = html;
}

const adminDescriptions = {
  "Playback": "I-replay ang galaw ng user. (Malapit na)",
  "Geofence": "Pamahalaan ang mga geofence zone. (Malapit na)",
  "Attendance": "Talaan ng attendance. (Malapit na)",
  "Announcements": "Mga anunsyo. (Malapit na)",
  "SOS Alerts": "Mga SOS alert. (Malapit na)",
  "Daily Reports": "Pang-araw-araw na ulat. (Malapit na)",
  "Admin Settings": "Mga setting ng admin. (Malapit na)"
};

async function showAdminPage(page) {
  lastUserListMode = null;
  stopLivePoll();
  destroyActiveChat();
  liveMap = null;
  liveMarkers = {};
  liveUserData = {};

  switch (page) {
    case "Dashboard":
      return renderAdminDashboard();
    case "Live GPS Map":
      return renderLiveMapPage();
    case "Users / Accounts":
      return renderUserList("users");
    case "Location History":
      return renderUserList("history");
    case "Chat & Photos":
      return renderUserList("chat");
    default:
      setAdminContent(adminDescriptions[page] || "");
  }
}

async function renderAdminDashboard() {
  setAdminContent(adminDashboardHtml);

  const { data, error } = await db
    .from("profiles")
    .select("id, role, is_online, last_seen, location_sharing, is_active");

  if (error || !data) return;

  const users = data.filter((p) => p.role !== "admin");
  const online = users.filter((p) => isReallyOnline(p)).length;
  const cards = document.querySelectorAll(".cards .card strong");
  if (cards[0]) cards[0].textContent = users.length;
  if (cards[1]) cards[1].textContent = users.filter((p) => p.location_sharing).length;
  if (cards[2]) cards[2].textContent = users.filter((p) => !p.location_sharing).length;
  if (cards[3]) cards[3].textContent = online;
}

// ===== Admin: gumawa ng user =====
function createUserFormHtml() {
  const inp = "padding:8px;border:1px solid #cbd5e1;border-radius:6px;width:100%;box-sizing:border-box;";
  return `
    <details style="margin-bottom:14px;border:1px solid #e2e8f0;border-radius:8px;padding:10px;background:#fff;">
      <summary style="cursor:pointer;font-weight:bold;color:#1769aa;">➕ Gumawa ng bagong user</summary>
      <div style="display:grid;gap:8px;margin-top:10px;">
        <input id="newUserName" type="text" placeholder="Buong pangalan" style="${inp}">
        <input id="newUserEmail" type="email" placeholder="Email" style="${inp}">
        <input id="newUserPhone" type="tel" placeholder="Telepono (hal. 09171234567)" style="${inp}">
        <input id="newUserPassword" type="password" placeholder="Password (min. 6 characters)" style="${inp}">
        <select id="newUserRole" style="${inp}">
          <option value="user">User</option>
          <option value="admin">Admin</option>
        </select>
        <button type="button" data-act="create-user"
          style="padding:8px;background:#1769aa;color:#fff;border:none;border-radius:6px;">Gumawa ng account</button>
        <div id="createUserMsg" style="font-size:13px;color:#b42318;"></div>
      </div>
    </details>
  `;
}

async function handleCreateUser(btn) {
  const msg = document.getElementById("createUserMsg");
  const name = document.getElementById("newUserName").value.trim();
  const email = document.getElementById("newUserEmail").value.trim();
  const phone = document.getElementById("newUserPhone").value.trim();
  const password = document.getElementById("newUserPassword").value;
  const role = document.getElementById("newUserRole").value;

  if (!name || !email || !phone || !password) {
    msg.style.color = "#b42318";
    msg.textContent = "Kumpletuhin ang pangalan, email, telepono, at password.";
    return;
  }
  if (!/^\+?[0-9\s-]{7,20}$/.test(phone)) {
    msg.style.color = "#b42318";
    msg.textContent = "Hindi valid ang numero ng telepono.";
    return;
  }
  if (password.length < 6) {
    msg.style.color = "#b42318";
    msg.textContent = "Dapat at least 6 characters ang password.";
    return;
  }

  btn.disabled = true;
  msg.style.color = "#64748b";
  msg.textContent = "Ginagawa ang account...";

  try {
    const { data, error } = await db.functions.invoke("admin-create-user", {
      body: { email, password, full_name: name, phone, role }
    });

    if (error) {
      let errMsg = error.message || String(error);
      if (error.context && typeof error.context.json === "function") {
        try {
          const body = await error.context.json();
          if (body && body.error) errMsg = body.error;
        } catch (_) {}
      }
      throw new Error(errMsg);
    }
    if (data && data.error) throw new Error(data.error);

    alert("Matagumpay na nagawa ang account ng " + name + ".");
    renderUserList("users");
  } catch (err) {
    msg.style.color = "#b42318";
    msg.textContent = "Error: " + err.message;
    btn.disabled = false;
  }
}

  
  
    

// ===== Admin: listahan ng users =====
// ===== Admin: i-activate / i-deactivate =====
async function toggleUserActive(userId, makeActive) {
  const label = makeActive ? "i-activate" : "i-deactivate";
  if (!confirm("Sigurado ka bang gusto mong " + label + " ang account na ito?")) return;

  const changes = { is_active: makeActive };
  if (!makeActive) {
    changes.is_online = false;
    changes.location_sharing = false;
  }

  const { data, error } = await db
    .from("profiles")
    .update(changes)
    .eq("id", userId)
    .select("id, is_active");

  if (error) {
    alert("Error: " + error.message);
    return;
  }
  if (!data || data.length === 0) {
    alert("Hindi na-update ang account. Tingnan kung tama ang SQL policy at admin ang role mo.");
    return;
  }

  renderUserList(lastUserListMode || "users");
}
async function renderUserList(mode) {
  lastUserListMode = mode;
  const formHtml = mode === "users" ? createUserFormHtml() : "";
  setAdminContent(formHtml + "<div id='adminUsersLoaded' style='color:#64748b;font-size:13px;'>Naglo-load...</div>");

  const { data, error } = await db
    .from("profiles")
    .select("id, full_name, phone, role, is_active, is_online, last_seen, battery_level, is_charging, location_name, latitude, longitude")
    .neq("role", "admin")
    .order("full_name", { ascending: true });

  if (error) {
    setAdminContent(formHtml + "<div style='color:#b42318;'>Error: " + escapeHtml(error.message) + "</div>");
    return;
  }
  if (!data || data.length === 0) {
    setAdminContent(formHtml + "<div style='color:#64748b;'>Walang user.</div>");
    return;
  }

  const btn = "padding:6px 10px;border:none;border-radius:6px;color:#fff;font-size:13px;margin:2px;";

  const rows = data.map((p) => {
    const online = isReallyOnline(p);
    const active = p.is_active !== false;
    const name = escapeHtml(p.full_name || "User");
    const uid = escapeHtml(p.id);
    const phoneCell = p.phone ? telLink(p.phone) : "—";
    let actions = "";

    if (mode === "users" || mode === "chat") {
      actions += `<button type="button" data-act="admin-chat" data-uid="${uid}" data-name="${name}" style="${btn}background:#1769aa;">💬 Chat</button>`;
    }
    if (mode === "users" || mode === "history") {
      actions += `<button type="button" data-act="admin-history" data-uid="${uid}" data-name="${name}" style="${btn}background:#0f766e;">🕘 History</button>`;
    }
    if (mode === "users") {
      actions += active
        ? `<button type="button" data-act="toggle-active" data-uid="${uid}" data-active="true" style="${btn}background:#b42318;">⏸ Deactivate</button>`
        : `<button type="button" data-act="toggle-active" data-uid="${uid}" data-active="false" style="${btn}background:#137333;">▶ Activate</button>`;
    }
    if (p.latitude != null && p.longitude != null) {
      actions += `<button type="button" data-act="nav-route" data-lat="${p.latitude}" data-lng="${p.longitude}" data-name="${name}" style="${btn}background:#0f766e;">🧭 Ruta</button>`;
    }

    return `
      <tr style="border-bottom:1px solid #e2e8f0;">
        <td style="padding:8px;">${name}${active ? "" : " <small style='color:#b42318;'>(naka-deactivate)</small>"}</td>
        <td style="padding:8px;">${phoneCell}</td>
        <td style="padding:8px;color:${online ? "#137333" : "#64748b"};">${online ? "🟢 Online" : "⚪ Offline"}</td>
        <td style="padding:8px;">${escapeHtml(batteryLabel(p))}</td>
        <td style="padding:8px;">${escapeHtml(p.location_name ? shortPlace(p.location_name) : "—")}</td>
        <td style="padding:8px;">${actions}</td>
      </tr>`;
  }).join("");

  setAdminContent(formHtml + `
    <div id="adminUsersLoaded" style="overflow-x:auto;">
      <table style="width:100%;border-collapse:collapse;font-size:14px;">
        <thead>
          <tr style="text-align:left;border-bottom:2px solid #e2e8f0;">
            <th style="padding:8px;">Pangalan</th>
            <th style="padding:8px;">Telepono</th>
            <th style="padding:8px;">Status</th>
            <th style="padding:8px;">Baterya</th>
            <th style="padding:8px;">Lugar</th>
            <th style="padding:8px;">Aksyon</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `);
}

async function renderAdminChatPage(userId, name) {
  setAdminContent(`
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:10px;">
      <button type="button" data-act="admin-back" style="padding:6px 10px;border:none;border-radius:6px;background:#64748b;color:#fff;">← Listahan</button>
      <strong>💬 ${escapeHtml(name)}</strong>
    </div>
    <div id="adminChatBody"></div>
  `);

  const myId = adminSelfId || (await getCurrentUserId());
  await mountChat(document.getElementById("adminChatBody"), "ac", "", 380, myId, userId);
}

async function renderUserHistory(userId, name) {
  setAdminContent("<div style='color:#64748b;font-size:13px;'>Naglo-load...</div>");

  const { data, error } = await db
    .from("location_logs")
    .select("created_at, event, location_name, latitude, longitude, battery_level, is_charging")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(500);

  if (error) {
    setAdminContent("<div style='color:#b42318;'>Error: " + escapeHtml(error.message) + "</div>");
    return;
  }

  const back = `<button type="button" data-act="admin-back" style="margin-bottom:10px;padding:6px 10px;border:none;border-radius:6px;background:#64748b;color:#fff;">← Listahan</button>`;

  if (!data || data.length === 0) {
    setAdminContent(back + "<div style='color:#64748b;'>Walang history si " + escapeHtml(name) + ".</div>");
    return;
  }

  const eventLabel = (ev) => {
    if (ev === "login") return "🟢 Login";
    if (ev === "logout") return "🔴 Logout";
    return "📍 Lokasyon";
  };
  const coordText = (r) =>
    r.latitude != null && r.longitude != null
      ? `${Number(r.latitude).toFixed(6)}, ${Number(r.longitude).toFixed(6)}`
      : "—";
  const placeText = (r) => r.location_name || "—";
  const battText = (r) => (r.battery_level != null ? r.battery_level + "%" : "—");

  const btnStyle = "padding:6px 10px;border:none;border-radius:6px;color:#fff;font-size:13px;";
  const toolbar = `
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px;">
      <button type="button" id="histCsvBtn" style="${btnStyle}background:#137333;">⬇ I-save bilang CSV (Excel)</button>
      <button type="button" id="histPdfBtn" style="${btnStyle}background:#b42318;">🖨 I-save bilang PDF</button>
    </div>`;

  const rows = data.map((r) => {
    const isSession = r.event === "login" || r.event === "logout";
    const rowBg = r.event === "login" ? "background:#e7f6ec;" : r.event === "logout" ? "background:#fdecea;" : "";
    return `
    <tr style="border-bottom:1px solid #e2e8f0;${rowBg}${isSession ? "font-weight:bold;" : ""}">
      <td style="padding:6px;">${escapeHtml(new Date(r.created_at).toLocaleString("fil-PH"))}</td>
      <td style="padding:6px;">${eventLabel(r.event)}</td>
      <td style="padding:6px;">${escapeHtml(placeText(r))}</td>
      <td style="padding:6px;">${escapeHtml(coordText(r))}</td>
      <td style="padding:6px;">${escapeHtml(battText(r))}</td>
    </tr>`;
  }).join("");

  setAdminContent(`
    ${back}
    <h3 style="margin:0 0 8px;">🕘 ${escapeHtml(name)}</h3>
    ${toolbar}
    <div style="overflow-x:auto;">
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <thead>
          <tr style="text-align:left;border-bottom:2px solid #e2e8f0;">
            <th style="padding:6px;">Oras</th>
            <th style="padding:6px;">Uri</th>
            <th style="padding:6px;">Lugar</th>
            <th style="padding:6px;">Coordinates</th>
            <th style="padding:6px;">Baterya</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `);

  const plainEvent = (ev) => (ev === "login" ? "Login" : ev === "logout" ? "Logout" : "Lokasyon");
  const csvEscape = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;

  document.getElementById("histCsvBtn").onclick = () => {
    const header = ["Oras", "Uri", "Lugar", "Latitude", "Longitude", "Baterya", "Charging"];
    const lines = data.map((r) => [
      new Date(r.created_at).toLocaleString("fil-PH"),
      plainEvent(r.event),
      r.location_name || "",
      r.latitude ?? "",
      r.longitude ?? "",
      r.battery_level ?? "",
      r.is_charging == null ? "" : (r.is_charging ? "Oo" : "Hindi")
    ].map(csvEscape).join(","));

    const csv = "\uFEFF" + [header.map(csvEscape).join(","), ...lines].join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const today = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `history_${(name || "user").replace(/[^\w]+/g, "_")}_${today}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  document.getElementById("histPdfBtn").onclick = () => {
    const win = window.open("", "_blank");
    if (!win) {
      alert("Pinigilan ng browser ang popup. Payagan ito at subukan ulit.");
      return;
    }
    win.document.write(`
      <html><head><title>History - ${escapeHtml(name)}</title>
      <style>
        body { font-family: Arial, sans-serif; font-size: 12px; margin: 20px; }
        h2 { color: #6b0000; margin: 0 0 4px; }
        p { color: #64748b; margin: 0 0 12px; }
        table { width: 100%; border-collapse: collapse; }
        th, td { border-bottom: 1px solid #ccc; padding: 6px; text-align: left; }
        th { background: #fbf1d0; }
        tr.login td { background: #e7f6ec; font-weight: bold; }
        tr.logout td { background: #fdecea; font-weight: bold; }
      </style></head><body>
      <h2>Location History: ${escapeHtml(name)}</h2>
      <p>Na-export: ${escapeHtml(new Date().toLocaleString("fil-PH"))} · ${data.length} na talaan</p>
      <table>
        <thead><tr><th>Oras</th><th>Uri</th><th>Lugar</th><th>Coordinates</th><th>Baterya</th></tr></thead>
        <tbody>${data.map((r) => `
          <tr class="${r.event === "login" ? "login" : r.event === "logout" ? "logout" : ""}">
            <td>${escapeHtml(new Date(r.created_at).toLocaleString("fil-PH"))}</td>
            <td>${escapeHtml(plainEvent(r.event))}</td>
            <td>${escapeHtml(placeText(r))}</td>
            <td>${escapeHtml(coordText(r))}</td>
            <td>${escapeHtml(battText(r))}</td>
          </tr>`).join("")}
        </tbody>
      </table>
      </body></html>
    `);
    win.document.close();
    win.focus();
    win.print();
  };
}

// ===== Admin: menu router (isa lang) =====
document.querySelectorAll("#menu button[data-page]").forEach((btn) => {
  btn.addEventListener("click", async () => {
    document.querySelectorAll("#menu button").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");

    const page = btn.dataset.page;
    document.getElementById("pageTitle").textContent = page;
    document.getElementById("panelTitle").textContent = page;

    await showAdminPage(page);
  });
});

// ===== Admin: delegated listener para sa mga button sa panel =====
document.getElementById("panelContent").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn || btn.disabled) return;

  const act = btn.dataset.act;
  const uid = btn.dataset.uid;
  const name = btn.dataset.name;

  if (act === "admin-chat") renderAdminChatPage(uid, name);
  else if (act === "admin-history") renderUserHistory(uid, name);
  else if (act === "admin-back") renderUserList(lastUserListMode || "users");
  else if (act === "create-user") handleCreateUser(btn);
  else if (act === "toggle-active") toggleUserActive(uid, btn.dataset.active !== "true");
  else if (act === "live-chat") openLiveChat(uid);
  else if (act === "nav-gmap") openGoogleMaps(parseFloat(btn.dataset.lat), parseFloat(btn.dataset.lng));
  else if (act === "nav-waze") openWaze(parseFloat(btn.dataset.lat), parseFloat(btn.dataset.lng));
  else if (act === "nav-route") showAdminRouteOnMap(parseFloat(btn.dataset.lat), parseFloat(btn.dataset.lng), btn.dataset.name || "User");
});

// ===== Admin: hamburger menu (mobile) =====
const menuToggle = document.getElementById("menuToggle");
const menuOverlay = document.getElementById("menuOverlay");
const adminMenu = document.getElementById("menu");

function openAdminMenu() {
  adminMenu.classList.add("open");
  menuOverlay.classList.add("show");
}

function closeAdminMenu() {
  adminMenu.classList.remove("open");
  menuOverlay.classList.remove("show");
}

if (menuToggle) {
  menuToggle.addEventListener("click", () => {
    adminMenu.classList.contains("open") ? closeAdminMenu() : openAdminMenu();
  });
}

if (menuOverlay) menuOverlay.addEventListener("click", closeAdminMenu);

document.querySelectorAll("#menu button").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (window.innerWidth <= 768) closeAdminMenu();
  });
});

// ===== Startup: i-check ang session =====
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