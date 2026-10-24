
"use strict";

const $ = id => document.getElementById(id);

const money = n =>
  "₹" + Number(n || 0).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;"
}[c]));

const phoneOf = p => {
  const s = String(p || "").replace(/\D/g, "");
  return s.length === 12 && s.startsWith("91") ? s.slice(2) : s;
};

const fmtDate = s => new Date(s).toLocaleString("en-IN");

const state = {
  me: null,
  profiles: [],
  selected: null,
  picture: null,
  pictureURL: null,
  photoWeight: 0,
  camera: null,
  orders: [],
  orderForPrint: null,
  orderInDetails: null
};

let toastTimer;
let authMode = "login";

function toast(message) {
  $("toast").textContent = message;
  $("toast").classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    $("toast").classList.remove("visible");
  }, 4800);
}

function busy(button, value) {
  if (value) {
    button.dataset.old = button.innerHTML;
    button.innerHTML = "Working...";
    button.disabled = true;
  } else {
    button.innerHTML = button.dataset.old || button.innerHTML;
    button.disabled = false;
  }
}

async function api(path, options = {}) {
  const headers = {...(options.headers || {})};

  if (options.body && !(options.body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch("/api" + path, {
    credentials: "same-origin",
    ...options,
    headers
  });

  let data;

  try {
    data = await response.json();
  } catch {
    throw Error("Server unavailable. Check Cloudflare deployment.");
  }

  if (!response.ok) throw Error(data.error || "Request failed.");
  return data;
}

const post = (path, body) => api(path, {
  method: "POST",
  body: JSON.stringify(body)
});

function view(name) {
  ["auth", "otp", "setup", "gate", "app"].forEach(id => {
    $(id).classList.toggle("hidden", id !== name);
  });

  $("mobileNav").classList.toggle("hidden", name !== "app");
}

function modal(name, open = true) {
  $(name).classList.toggle("hidden", !open);

  if (!open && name === "cameraModal") {
    stopCamera();
  }

  document.body.style.overflow =
    document.querySelector(".modal:not(.hidden)") ? "hidden" : "";
}

// AUTHENTICATION

async function refreshSession() {
  const result = await api("/auth/me");

  state.me = result.authenticated ? result : null;

  if (!result.authenticated) {
    if (result.otp_pending) {
      $("otpDestination").textContent =
        result.email_masked || "your email address";
      view("otp");
    } else {
      view("auth");
    }
    return;
  }

  if (!result.has_owner_pin) {
    view("setup");
    return;
  }

  if (!result.staff) {
    await showPINProfiles();
    return;
  }

  dashboard();
}

function setAuthMode(mode) {
  authMode = mode;

  $("signupFields").classList.toggle("hidden", mode !== "signup");
  $("business").required = mode === "signup";
  $("ownerName").required = mode === "signup";

  $("tabLogin").classList.toggle("on", mode === "login");
  $("tabSignup").classList.toggle("on", mode === "signup");

  $("authTitle").textContent =
    mode === "login" ? "A finer way to work." : "Join the golden standard.";

  $("authSubmit").textContent =
    mode === "login" ? "Enter workspace →" : "Create business →";
}

$("tabLogin").onclick = () => setAuthMode("login");
// Open registration is disabled. Applications use /register.html.

$("authForm").onsubmit = async event => {
  event.preventDefault();

  const button = $("authSubmit");
  busy(button, true);

  try {
    const email = $("email").value.trim();
    const password = $("password").value;

    if (authMode === "signup") {
      await post("/auth/signup", {
        email,
        password,
        business: $("business").value.trim(),
        name: $("ownerName").value.trim()
      });

      $("password").value = "";
      setAuthMode("login");
      toast("Business registered. Sign in to continue.");
    } else {
      const result = await post("/auth/login", {email, password});
      $("password").value = "";

      if (result.otp_required) {
        $("otpDestination").textContent = result.email_masked;
        $("emailOtp").value = "";
        view("otp");
        toast("Verification email sent.");
      } else {
        await refreshSession();
      }
    }
  } catch (err) {
    toast(err.message);
  } finally {
    busy(button, false);
  }
};

// EMAIL OTP

$("otpForm").onsubmit = async event => {
  event.preventDefault();

  const button = $("otpVerify");
  busy(button, true);

  try {
    await post("/auth/otp/verify", {
      code: $("emailOtp").value.trim()
    });

    $("emailOtp").value = "";
    await refreshSession();
    toast("Email verified. Enter your profile PIN.");
  } catch (err) {
    toast(err.message);
    $("emailOtp").value = "";
  } finally {
    busy(button, false);
  }
};

$("otpResend").onclick = async () => {
  const button = $("otpResend");
  busy(button, true);

  try {
    const result = await post("/auth/otp/resend", {});
    toast(result.message || "Another code was sent.");
  } catch (err) {
    toast(err.message);
  } finally {
    busy(button, false);
  }
};

$("otpCancel").onclick = async () => {
  try {
    await post("/auth/otp/cancel", {});
  } catch {}
  $("emailOtp").value = "";
  view("auth");
};

// OWNER PIN

$("setupForm").onsubmit = async event => {
  event.preventDefault();

  const pin = $("setupPin").value;

  if (pin !== $("setupRepeat").value) {
    return toast("Owner PINs do not match.");
  }

  try {
    await post("/auth/owner-pin", {pin});
    $("setupForm").reset();
    await refreshSession();
    toast("Owner PIN created.");
  } catch (err) {
    toast(err.message);
  }
};

// PROFILE LOGIN

async function showPINProfiles() {
  const result = await api("/staff");

  state.profiles = result.staff.filter(x => x.active);

  if (!state.profiles.some(x => x.id === state.selected)) {
    state.selected = state.profiles[0]?.id;
  }

  $("gateStore").textContent =
    state.me.owner.business + " · Select your profile";

  $("profiles").innerHTML = state.profiles.map(p => `
    <button type="button"
      class="profile ${p.id === state.selected ? "selected" : ""}"
      data-staff="${esc(p.id)}">
      ${esc(p.name)}
      <small>${p.role === "owner" ? "Owner" : "Employee"}</small>
    </button>
  `).join("");

  $("unlockPin").value = "";
  view("gate");
}

$("profiles").onclick = event => {
  const button = event.target.closest("[data-staff]");
  if (!button) return;

  state.selected = button.dataset.staff;

  document.querySelectorAll(".profile").forEach(p => {
    p.classList.toggle(
      "selected",
      p.dataset.staff === state.selected
    );
  });
};

$("gateForm").onsubmit = async event => {
  event.preventDefault();

  const button = $("gateForm").querySelector("button[type=submit]");
  busy(button, true);

  try {
    await post("/auth/unlock", {
      id: state.selected,
      pin: $("unlockPin").value
    });

    await refreshSession();
  } catch (err) {
    toast(err.message);
    $("unlockPin").value = "";
  } finally {
    busy(button, false);
  }
};

async function logout() {
  try {
    await post("/auth/logout", {});
  } catch {}

  state.me = null;
  state.orders = [];
  clearPhoto();

  ["accountModal", "detailModal", "printModal", "confirmModal"].forEach(
    id => modal(id, false)
  );

  view("auth");
}

async function switchProfile() {
  try {
    await post("/auth/lock", {});
    clearPhoto();
    modal("accountModal", false);
    await refreshSession();
  } catch (err) {
    toast(err.message);
  }
}

["setupLogout", "gateLogout", "sideLogout",
 "settingsLogout", "accountLogout"].forEach(id => {
  $(id).onclick = logout;
});

["switchProfile", "settingsSwitch", "accountSwitch"].forEach(id => {
  $(id).onclick = switchProfile;
});

$("mobileAccount").onclick = () => modal("accountModal");

// DASHBOARD

function dashboard() {
  view("app");

  const staff = state.me.staff;

  $("sideIdentity").textContent = staff.name;
  $("sideRole").textContent =
    staff.role === "owner" ? "Business owner" : "Finance employee";

  $("avatarLetter").textContent = staff.name[0]?.toUpperCase() || "S";
  $("storeHeading").textContent = state.me.owner.business;

  $("todayDate").textContent = new Date().toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric"
  });

  document.querySelectorAll(".owner-only").forEach(el => {
    el.classList.toggle("hidden", staff.role !== "owner");
  });

  navigate("new");

  if (new URLSearchParams(location.search).has("drive")) {
    toast("Google authorization completed. Check Settings.");
    history.replaceState({}, "", location.pathname);
  }
}

function navigate(name) {
  if (name === "settings" && state.me?.staff?.role !== "owner") {
    return toast("Only the owner can access Settings.");
  }

  ["new", "lookup", "settings"].forEach(p => {
    $(p + "Page").classList.toggle("hidden", p !== name);
  });

  document.querySelectorAll("[data-page]").forEach(el => {
    el.classList.toggle("active", el.dataset.page === name);
  });

  $("topTitle").textContent = {
    new: "The gold desk",
    lookup: "Customer archive",
    settings: "Settings & connections"
  }[name];

  $("breadcrumb").textContent = name.toUpperCase();

  if (name === "new") loadSummary();

  if (name === "settings") {
    loadTeam();
    driveStatus();
    sheetsStatus();
    loadPrinterPrefs();
  }

  window.scrollTo(0, 0);
}

document.querySelectorAll("[data-page]").forEach(el => {
  el.onclick = () => navigate(el.dataset.page);
});

async function loadSummary() {
  if (!state.me?.staff) return;

  try {
    const result = await api("/summary");

    $("kpiOrders").textContent = Number(result.total)
      .toLocaleString("en-IN");

    $("kpiAmount").textContent = money(result.amount);
    $("kpiBackups").textContent = result.backed_up;

    $("recentList").innerHTML = result.recent.length
      ? result.recent.map(order => `
        <div class="recent-row">
          <div>
            <strong>${esc(order.customer)} · ${esc(order.item)}</strong>
            <small>${esc(order.number)} · ${esc(fmtDate(order.created_at))}</small>
          </div>
          <b>${money(order.amount)}</b>
        </div>
      `).join("")
      : '<div class="empty-row">No finance orders yet.</div>';
  } catch (err) {
    toast(err.message);
  }
}

$("refreshHome").onclick = loadSummary;

// FINANCE CALCULATION

function calc() {
  const weight = Number($("weight").value) || 0;
  const rate = Number($("rate").value) || 0;
  const percent = Number($("percent").value) || 0;

  return {
    w: weight,
    r: rate,
    p: percent,
    market: weight * rate,
    amount: Math.round(weight * rate * percent) / 100
  };
}

function renderQuote() {
  const q = calc();

  $("quoteAmount").textContent = money(q.amount);
  $("sumWeight").textContent = q.w.toFixed(3) + " g";
  $("sumRate").textContent = money(q.r);
  $("sumMarket").textContent = money(q.market);
  $("sumPercent").textContent = q.p + "%";
  $("sumAmount").textContent = money(q.amount);
}

["weight", "rate", "percent"].forEach(id => {
  $(id).addEventListener("input", () => {
    if (
      id === "weight" &&
      state.picture &&
      state.photoWeight !== Number($("weight").value)
    ) {
      clearPhoto();
      toast("Weight changed. Take the photo again.");
    }

    renderQuote();
  });
});

// CAMERA AND PHOTO STAMP

function clearPhoto() {
  if (state.pictureURL) URL.revokeObjectURL(state.pictureURL);

  state.picture = null;
  state.pictureURL = null;
  state.photoWeight = 0;

  $("photoPreview").removeAttribute("src");
  $("photoPreview").classList.add("hidden");
  $("removePhoto").classList.add("hidden");
  $("uploadFile").value = "";
}

function stopCamera() {
  state.camera?.getTracks().forEach(track => track.stop());
  state.camera = null;
  $("video").srcObject = null;
}

async function stampPhoto(source, width, height) {
  const scale = Math.min(1, 1100 / width);

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));

  const c = canvas.getContext("2d");
  c.drawImage(source, 0, 0, canvas.width, canvas.height);

  const bar = Math.max(76, canvas.height * .16);

  c.fillStyle = "#173d32";
  c.fillRect(0, canvas.height - bar, canvas.width, bar);

  c.fillStyle = "#ecd19a";
  c.font = `bold ${Math.max(17, canvas.width * .024)}px Arial`;
  c.fillText("SWARNA FINANCE", 18, canvas.height - bar * .68);

  c.fillStyle = "white";
  c.font = `bold ${Math.max(18, canvas.width * .029)}px Arial`;
  c.fillText(
    "NET WEIGHT " + Number($("weight").value).toFixed(3) + " g",
    18, canvas.height - bar * .22
  );

  c.textAlign = "right";
  c.font = `${Math.max(12, canvas.width * .015)}px Arial`;
  c.fillText(
    new Date().toLocaleString("en-IN"),
    canvas.width - 16,
    canvas.height - bar * .68
  );

  let blob = await new Promise(resolve =>
    canvas.toBlob(resolve, "image/jpeg", .8)
  );

  if (blob?.size > 1900000) {
    blob = await new Promise(resolve =>
      canvas.toBlob(resolve, "image/jpeg", .5)
    );
  }

  if (!blob || blob.size > 1900000) {
    throw Error("Image too large. Choose another photo.");
  }

  clearPhoto();

  state.picture = blob;
  state.photoWeight = Number($("weight").value);
  state.pictureURL = URL.createObjectURL(blob);

  $("photoPreview").src = state.pictureURL;
  $("photoPreview").classList.remove("hidden");
  $("removePhoto").classList.remove("hidden");

  toast("Photo captured with gold weight and date.");
}

$("openCamera").onclick = async () => {
  if (!(Number($("weight").value) > 0)) {
    return toast("Enter gold weight first.");
  }

  try {
    state.camera = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {facingMode: {ideal: "environment"}}
    });

    $("video").srcObject = state.camera;
    modal("cameraModal");
  } catch {
    toast("Camera unavailable. Use Upload image.");
  }
};

$("capture").onclick = async () => {
  const video = $("video");

  if (!video.videoWidth) {
    return toast("Camera is not ready.");
  }

  try {
    await stampPhoto(
      video,
      video.videoWidth,
      video.videoHeight
    );
    modal("cameraModal", false);
  } catch (err) {
    toast(err.message);
  }
};

$("uploadButton").onclick = () => $("uploadFile").click();

$("uploadFile").onchange = async event => {
  const file = event.target.files[0];
  if (!file) return;

  if (!(Number($("weight").value) > 0)) {
    return toast("Enter gold weight before uploading.");
  }

  if (!file.type.startsWith("image/")) {
    return toast("Select an image file.");
  }

  const url = URL.createObjectURL(file);
  const img = new Image();

  try {
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = url;
    });

    await stampPhoto(img, img.naturalWidth, img.naturalHeight);
  } catch (err) {
    toast("Photo error: " + err.message);
  } finally {
    URL.revokeObjectURL(url);
  }
};

$("removePhoto").onclick = clearPhoto;

// ORDER CONFIRMATION

function rowsHTML(fields) {
  return fields.map(([label, value]) => `
    <div>
      <span>${esc(label)}</span>
      <strong>${esc(value)}</strong>
    </div>
  `).join("");
}

$("proceed").onclick = () => {
  if (!$("orderForm").reportValidity()) return;

  const phone = phoneOf($("phone").value);
  const q = calc();

  if (!/^\d{10}$/.test(phone)) {
    return toast("Enter a valid 10-digit mobile number.");
  }

  if (
    q.w <= 0 || q.r <= 0 ||
    q.p <= 0 || q.p > 100 ||
    !Number.isFinite(q.amount) || q.amount <= 0
  ) {
    return toast("Enter valid gold finance values.");
  }

  if (!state.picture) {
    return toast("Take or upload a jewellery photograph.");
  }

  $("confirmationLines").innerHTML = rowsHTML([
    ["Customer", $("customer").value.trim()],
    ["Phone", phone],
    ["Jewellery", $("item").value],
    ["Weight", q.w.toFixed(3) + " g"],
    ["Gold rate", money(q.r)],
    ["Finance percentage", q.p + "%"],
    ["Finance amount", money(q.amount)]
  ]);

  $("customerAccepted").checked = false;
  $("confirmPin").value = "";
  modal("confirmModal");
};

$("saveOrder").onclick = async () => {
  if (!$("customerAccepted").checked) {
    return toast("Confirm customer acceptance.");
  }

  const pin = $("confirmPin").value;

  if (!/^\d{6}$/.test(pin)) {
    return toast("Enter your six-digit PIN.");
  }

  const q = calc();

  const values = {
    customer: $("customer").value.trim(),
    phone: phoneOf($("phone").value),
    item: $("item").value,
    description: $("description").value,
    weight: q.w,
    rate: q.r,
    percent: q.p,
    pin,
    accepted: "yes"
  };

  const form = new FormData();

  for (const [key, value] of Object.entries(values)) {
    form.append(key, String(value));
  }

  form.append("photo", state.picture, "gold-item.jpg");

  const button = $("saveOrder");
  busy(button, true);

  try {
    const result = await api("/orders", {
      method: "POST",
      body: form
    });

    const lookup = await api(
      "/orders?phone=" + encodeURIComponent(values.phone)
    );

    state.orderForPrint =
      lookup.orders.find(o => o.id === result.order.id) || {
        ...values,
        number: result.order.number,
        amount: q.amount,
        staff_name: state.me.staff.name,
        created_at: new Date().toISOString()
      };

    modal("confirmModal", false);

    $("printOrderNo").textContent = result.order.number;
    modal("printModal");

    $("orderForm").reset();
    $("percent").value = 60;
    clearPhoto();
    renderQuote();
    loadSummary();

    toast("Finance order saved. Print the receipt and label.");
  } catch (err) {
    toast(err.message);
    $("confirmPin").value = "";
  } finally {
    busy(button, false);
  }
};

$("printDone").onclick = () => {
  modal("printModal", false);
  state.orderForPrint = null;
  navigate("new");
};

// CUSTOMER LOOKUP

async function lookupOrders() {
  const phone = phoneOf($("lookupPhone").value);

  if (!/^\d{10}$/.test(phone)) {
    return toast("Enter a valid phone number.");
  }

  try {
    const result = await api(
      "/orders?phone=" + encodeURIComponent(phone)
    );

    state.orders = result.orders;

    $("lookupStatus").textContent =
      result.orders.length + " finance orders for " + phone;

    $("ordersTable").innerHTML = result.orders.map(x => `
      <tr>
        <td>
          <strong>${esc(x.number)}</strong>
          <small>${esc(fmtDate(x.created_at))}</small>
        </td>
        <td>${esc(x.customer)}</td>
        <td>${esc(x.item)}</td>
        <td>${Number(x.weight).toFixed(3)} g</td>
        <td>${money(x.amount)}</td>
        <td>
          <span class="status-tag">Drive: ${esc(x.backup_status)}</span>
          <span class="status-tag">Sheets: ${esc(x.sheet_status)}</span>
        </td>
        <td>
          <button class="btn outline small-btn"
            data-order="${esc(x.id)}">Details</button>
        </td>
      </tr>
    `).join("");
  } catch (err) {
    toast(err.message);
  }
}

$("lookupForm").onsubmit = event => {
  event.preventDefault();
  lookupOrders();
};

$("ordersTable").onclick = event => {
  const button = event.target.closest("[data-order]");
  if (!button) return;

  const x = state.orders.find(o => o.id === button.dataset.order);
  if (!x) return;

  state.orderInDetails = x;

  $("detailLines").innerHTML = rowsHTML([
    ["Order", x.number],
    ["Customer", x.customer],
    ["Phone", x.phone],
    ["Item", x.item],
    ["Description", x.description || "—"],
    ["Weight", Number(x.weight).toFixed(3) + " g"],
    ["Gold rate", money(x.rate)],
    ["Finance %", x.percent + "%"],
    ["Finance amount", money(x.amount)],
    ["Employee", x.staff_name],
    ["Date", fmtDate(x.created_at)],
    ["Drive backup", x.backup_status],
    ["Sheets backup", x.sheet_status]
  ]);

  $("detailImage").src =
    "/api/orders/" + encodeURIComponent(x.id) + "/photo";

  modal("detailModal");
};

// OWNER EMPLOYEE MANAGEMENT

async function loadTeam() {
  try {
    const result = await api("/staff");

    $("staffList").innerHTML = result.staff.map(x => `
      <div class="staff-row">
        <div>
          <strong>${esc(x.name)}</strong>
          <small>
            ${esc(x.role)} · ${x.active ? "Active" : "Disabled"}
          </small>
        </div>
        ${x.role === "employee" && x.active
          ? `<button class="btn ghost" data-disable="${esc(x.id)}">
               Disable
             </button>`
          : ""}
      </div>
    `).join("");
  } catch (err) {
    toast(err.message);
  }
}

$("employeeForm").onsubmit = async event => {
  event.preventDefault();

  if ($("employeePin").value !== $("employeeRepeat").value) {
    return toast("Employee PINs do not match.");
  }

  try {
    await post("/staff", {
      name: $("employeeName").value.trim(),
      pin: $("employeePin").value
    });

    $("employeeForm").reset();
    await loadTeam();
    toast("Employee profile created.");
  } catch (err) {
    toast(err.message);
  }
};

$("staffList").onclick = async event => {
  const button = event.target.closest("[data-disable]");
  if (!button) return;

  if (!confirm("Disable this employee?")) return;

  try {
    await post("/staff/" + button.dataset.disable + "/disable", {});
    await loadTeam();
    toast("Employee disabled.");
  } catch (err) {
    toast(err.message);
  }
};

// OWNER GOOGLE DRIVE FOLDER LINK CONTROL
function installDriveFolderInput() {
  const anchor=$("driveFolder");
  if(!anchor || document.getElementById("customDriveFolderForm")) return;
  const form=document.createElement("form");
  form.id="customDriveFolderForm";
  form.style.cssText="margin-top:18px;display:grid;gap:10px";
  const label=document.createElement("label");
  label.htmlFor="customDriveFolderURL";
  label.textContent="YOUR GOOGLE DRIVE FOLDER LINK";
  const input=document.createElement("input");
  input.id="customDriveFolderURL";
  input.type="url";
  input.required=true;
  input.placeholder="https://drive.google.com/drive/folders/...";
  input.style.cssText="width:100%;box-sizing:border-box;padding:14px;border:1px solid #ddd;border-radius:10px";
  const button=document.createElement("button");
  button.type="submit";
  button.className="btn primary";
  button.textContent="Save Drive Folder Link";
  const note=document.createElement("small");
  note.textContent="Connect your Google account first. New order backups will use this folder; existing backups will stay where they are.";
  form.append(label,input,button,note);
  anchor.insertAdjacentElement("afterend",form);
  form.onsubmit=async event=>{
    event.preventDefault();
    busy(button,true);
    try {
      await post("/drive/folder",{url:input.value.trim()});
      toast("Drive backup folder saved. New backups will use this folder.");
      await driveStatus();
    } catch(err) { toast(err.message); }
    finally { busy(button,false); }
  };
}
installDriveFolderInput();

// GOOGLE DRIVE

async function driveStatus() {
  try {
    const result = await api("/drive/status");
    const connected = result.connected;
    const totals = Object.fromEntries(
      result.totals.map(x => [x.backup_status, x.n])
    );

    $("driveStatus").textContent = connected
      ? `Connected · ${totals.synced || 0} synced · ` +
        `${totals.pending || 0} pending · ` +
        `${totals.failed || 0} failed`
      : "Not connected. Backups remain optional.";

    $("connectDrive").classList.toggle("hidden", connected);
    $("syncDrive").classList.toggle("hidden", !connected);
    $("disconnectDrive").classList.toggle("hidden", !connected);

    $("driveFolder").replaceChildren();

    if (result.folder_url) {
      $("customDriveFolderURL").value = result.folder_url;
      const link = document.createElement("a");
      link.href = result.folder_url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = "Open Google Drive backup folder ↗";
      $("driveFolder").append(link);
    }
  } catch (err) {
    toast(err.message);
  }
}

$("connectDrive").onclick = () => {
  location.href = "/api/drive/connect";
};

$("syncDrive").onclick = async () => {
  const button = $("syncDrive");
  busy(button, true);

  try {
    const result = await post("/drive/sync", {});
    toast(result.message);
    await driveStatus();
  } catch (err) {
    toast(err.message);
  } finally {
    busy(button, false);
  }
};

$("disconnectDrive").onclick = async () => {
  if (!confirm("Disconnect Google Drive? Existing backups remain there.")) {
    return;
  }

  try {
    await post("/drive/disconnect", {});
    await driveStatus();
    await sheetsStatus();
  } catch (err) {
    toast(err.message);
  }
};

// GOOGLE SHEETS

async function sheetsStatus() {
  try {
    const result = await api("/sheets/status");
    const totals = Object.fromEntries(
      result.totals.map(x => [x.sheet_status, x.n])
    );

    $("sheetsStatus").textContent = result.configured
      ? `${result.title} · ${totals.synced || 0} synced · ` +
        `${totals.pending || 0} pending · ` +
        `${totals.failed || 0} failed`
      : "No Google spreadsheet linked.";

    $("syncSheets").classList.toggle("hidden", !result.configured);
    $("unlinkSheets").classList.toggle("hidden", !result.configured);

    $("sheetsFolder").replaceChildren();

    if (result.url) {
      $("sheetURL").value = result.url;

      const a = document.createElement("a");
      a.href = result.url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = "Open linked Google Sheet ↗";

      $("sheetsFolder").append(a);
    }
  } catch (err) {
    toast(err.message);
  }
}

$("sheetLinkForm").onsubmit = async event => {
  event.preventDefault();

  try {
    const result = await post("/sheets/link", {
      url: $("sheetURL").value.trim()
    });

    toast("Connected to " + result.title);
    await sheetsStatus();
  } catch (err) {
    toast(err.message);
  }
};

$("syncSheets").onclick = async () => {
  const button = $("syncSheets");
  busy(button, true);

  try {
    const result = await post("/sheets/sync", {});
    toast(result.message);
    await sheetsStatus();
  } catch (err) {
    toast(err.message);
  } finally {
    busy(button, false);
  }
};

$("unlinkSheets").onclick = async () => {
  if (!confirm("Unlink the spreadsheet? Existing rows remain.")) return;

  try {
    await post("/sheets/unlink", {});
    $("sheetURL").value = "";
    await sheetsStatus();
  } catch (err) {
    toast(err.message);
  }
};

// RECEIPT AND LABEL PRINTERS

const printDefaults = {
  receipt: "80",
  label: "50x30"
};

function printerPrefs() {
  try {
    return {
      ...printDefaults,
      ...JSON.parse(localStorage.getItem("sf_print_v2") || "{}")
    };
  } catch {
    return {...printDefaults};
  }
}

function loadPrinterPrefs() {
  const p = printerPrefs();

  $("receiptSize").value = p.receipt;
  $("labelSize").value = p.label;
}

$("receiptSize").onchange = () => {
  const p = printerPrefs();
  p.receipt = $("receiptSize").value;
  localStorage.setItem("sf_print_v2", JSON.stringify(p));
  toast("Receipt size saved.");
};

$("labelSize").onchange = () => {
  const p = printerPrefs();
  p.label = $("labelSize").value;
  localStorage.setItem("sf_print_v2", JSON.stringify(p));
  toast("Label size saved.");
};

const exampleOrder = {
  number: "SF-20261021-DEMO1234",
  customer: "Sample Customer",
  phone: "9876543210",
  item: "Gold chain",
  description: "Sample item",
  weight: 20,
  rate: 14500,
  percent: 60,
  amount: 174000,
  staff_name: "Demo employee",
  created_at: new Date().toISOString()
};

function makePrintHTML(type, x) {
  const p = printerPrefs();
  const receipt = type === "receipt";

  const width = receipt
    ? (p.receipt === "a4" ? "210mm" : p.receipt + "mm")
    : p.label.split("x")[0] + "mm";

  const height = receipt
    ? (p.receipt === "a4" ? "297mm" : "210mm")
    : p.label.split("x")[1] + "mm";

  const lines = [
    ["Order number", x.number],
    ["Date", fmtDate(x.created_at)],
    ["Customer", x.customer],
    ["Phone", x.phone],
    ["Jewellery", x.item],
    ["Weight", Number(x.weight).toFixed(3) + " g"],
    ["Rate", money(x.rate)],
    ["Finance %", x.percent + "%"],
    ["Staff", x.staff_name]
  ];

  const receiptHTML = `
    <h1>✦ SWARNA FINANCE</h1>
    <p class="center">${esc(state.me?.owner?.business || "Jewellery Shop")}</p>
    <h2>FINANCE RECEIPT</h2>
    <p class="center"><b>${esc(x.number)}</b></p>
    ${lines.map(([a,b]) => `
      <div class="line"><span>${esc(a)}</span><b>${esc(b)}</b></div>
    `).join("")}
    <h3>FINANCE AMOUNT</h3>
    <div class="amount">${money(x.amount)}</div>
    <p class="fine">
      Customer acceptance was recorded by the employee.
      This receipt does not replace a legally required finance agreement.
    </p>
  `;

  const labelHTML = `
    <h1>✦ SWARNA</h1>
    <p class="center">GOLD FINANCE ITEM TAG</p>
    <h2>${esc(x.number)}</h2>
    <div class="line"><span>Item</span><b>${esc(x.item)}</b></div>
    <div class="line">
      <span>Weight</span><b>${Number(x.weight).toFixed(3)} g</b>
    </div>
    <div class="line">
      <span>Customer</span>
      <b>•••• ${esc(String(x.phone).slice(-4))}</b>
    </div>
    <div class="line">
      <span>Date</span>
      <b>${esc(new Date(x.created_at).toLocaleDateString("en-IN"))}</b>
    </div>
  `;

  return `<!DOCTYPE html>
  <html>
  <head>
    <meta charset="utf-8">
    <title>${receipt ? "Receipt" : "Label"} ${esc(x.number)}</title>
    <style>
      @page {size:${width} ${height};margin:0}
      * {box-sizing:border-box}
      body {margin:0;font-family:Arial,sans-serif;color:#222}
      .sheet {width:${width};padding:${receipt ? "4mm" : "2mm"}}
      h1 {font-size:${receipt ? "17pt" : "10pt"};text-align:center}
      h2 {font-size:${receipt ? "12pt" : "8pt"};text-align:center}
      h3 {font-size:10pt;text-align:center}
      .center,.fine {text-align:center}
      .center {font-size:9pt}
      .fine {font-size:7pt;line-height:1.4}
      .line {
        display:flex;justify-content:space-between;
        gap:5px;border-bottom:1px dotted #aaa;
        padding:4px 0;font-size:${receipt ? "9pt" : "7pt"};
      }
      .line b {text-align:right;overflow-wrap:anywhere}
      .amount {font-size:17pt;text-align:center;font-weight:800}
      .print {margin:10px;padding:10px}
      @media print {.print {display:none}}
    </style>
  </head>
  <body>
    <button class="print" onclick="window.print()">Print</button>
    <div class="sheet">${receipt ? receiptHTML : labelHTML}</div>
  </body>
  </html>`;
}

function printOrder(type, order) {
  if (!order) return toast("Select a finance order first.");

  const popup = window.open("", "_blank", "width=520,height=720");

  if (!popup) {
    return toast("Allow pop-ups to use printing.");
  }

  popup.document.open();
  popup.document.write(makePrintHTML(type, order));
  popup.document.close();

  popup.focus();

  setTimeout(() => {
    try {
      popup.print();
    } catch {}
  }, 350);
}

$("testReceipt").onclick = () => printOrder("receipt", exampleOrder);
$("testLabel").onclick = () => printOrder("label", exampleOrder);

$("printNewReceipt").onclick = () =>
  printOrder("receipt", state.orderForPrint);

$("printNewLabel").onclick = () =>
  printOrder("label", state.orderForPrint);

$("detailPrintReceipt").onclick = () =>
  printOrder("receipt", state.orderInDetails);

$("detailPrintLabel").onclick = () =>
  printOrder("label", state.orderInDetails);

// CLOSE MODALS

document.querySelectorAll("[data-close]").forEach(button => {
  button.onclick = () => modal(button.dataset.close, false);
});

document.querySelectorAll(".modal").forEach(el => {
  el.onclick = event => {
    if (event.target === el) modal(el.id, false);
  };
});

document.addEventListener("keydown", event => {
  if (event.key === "Escape") {
    document.querySelectorAll(".modal:not(.hidden)").forEach(el => {
      modal(el.id, false);
    });
  }
});

// START

setAuthMode("login");
renderQuote();
loadPrinterPrefs();

refreshSession().catch(err => {
  view("auth");
  toast(err.message);
});
