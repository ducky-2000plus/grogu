/* ============================================================
   Yet — cloud adapter
   ------------------------------------------------------------
   Paste this <script> block into index.html immediately BEFORE the
   main <script>, and set the two constants below. It replaces the
   device-only storage and password handling with Supabase, and adds
   an offline queue so a learner on bad wifi can keep working.

   Nothing else in index.html needs to change: the app already routes
   every read and write through STORE, and every credential check
   through the gate functions this file overrides.
   ============================================================ */

const YET_SUPABASE_URL = "https://qksijzzlwpcjismyvxcb.supabase.co";

// Supabase replaced the old `anon` key with a "publishable" key (sb_publishable_...).
// Either works today, but the legacy anon key is being retired at the end of
// 2026, so use the publishable one on a new project.
// This key is MEANT to sit in the browser. Row-level security is what protects
// the data. NEVER put a secret key (sb_secret_... or the legacy service_role)
// here — those bypass every policy in schema.sql.
const YET_SUPABASE_KEY = "sb_publishable_yP13zipvzJBSz72fRiW99Q__YYiyY7y";

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const sb = createClient(YET_SUPABASE_URL, YET_SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true }
});
window.sb = sb;
/* Tells index.html that a backend is attached, so the sign-in screen offers a
   real email + password form. Without this the profile list is empty when
   signed out — the security policies hide other people's rows, correctly —
   and a returning user has nothing to click. */
window.YET_CLOUD = true;

/* ---------- offline queue ----------
   A write that fails because the network is down is kept and replayed.
   Without this, a child in a classroom with patchy wifi silently loses
   their session. */
const QKEY = "yet.pending";
const queue = {
  all() { try { return JSON.parse(localStorage.getItem(QKEY) || "[]"); } catch { return []; } },
  push(item) {
    const q = this.all();
    // one pending write per profile is enough; the newest wins
    const i = q.findIndex(x => x.profile_id === item.profile_id);
    if (i >= 0) q[i] = item; else q.push(item);
    try { localStorage.setItem(QKEY, JSON.stringify(q)); } catch {}
  },
  clear() { try { localStorage.removeItem(QKEY); } catch {} }
};

async function flushQueue() {
  const q = queue.all();
  if (!q.length) return;
  for (const item of q) {
    const { error } = await sb.from("learner_state").upsert({
      profile_id: item.profile_id, state: item.state, updated_at: new Date()
    });
    if (error) return;            // still offline; keep everything for next time
  }
  queue.clear();
  if (typeof toast === "function") toast("Saved everything you did offline");
}
window.addEventListener("online", flushQueue);

/* ---------- the storage layer the app already talks to ---------- */
const idFromKey = k => (k && k.startsWith("yet:acct:")) ? k.slice(9) : null;

window.storage = {
  async get(key) {
    if (key === "yet:lang") {
      const v = localStorage.getItem("yet.lang");
      if (!v) throw new Error("missing " + key);
      return { key, value: v };
    }
    const id = idFromKey(key);
    if (!id) throw new Error("missing " + key);

    // an unsent local write is newer than the server copy
    const pending = queue.all().find(x => x.profile_id === id);
    if (pending) return { key, value: JSON.stringify(pending.state) };

    const { data, error } = await sb
      .from("learner_state").select("state").eq("profile_id", id).maybeSingle();
    if (error || !data) throw new Error("missing " + key);
    return { key, value: JSON.stringify(data.state) };
  },

  async set(key, value) {
    if (key === "yet:lang") { localStorage.setItem("yet.lang", value); return { key, value }; }
    const id = idFromKey(key);
    if (!id) return { key, value };
    const state = JSON.parse(value);
    const { error } = await sb.from("learner_state")
      .upsert({ profile_id: id, state, updated_at: new Date() });
    if (error) queue.push({ profile_id: id, state });   // keep it for later
    return { key, value };
  },

  async delete(key) {
    const id = idFromKey(key);
    if (id) await sb.from("learner_state").delete().eq("profile_id", id);
    return { key, deleted: true };
  },

  async list() { return { keys: [] }; }
};

/* ---------- wait until the app has defined its own functions ---------- */
window.addEventListener("DOMContentLoaded", () => setTimeout(installCloud, 0));

function installCloud() {
  if (typeof ACC === "undefined") { setTimeout(installCloud, 50); return; }

  /* ---- who can this user see? RLS answers that; we just ask. ---- */
  window.loadAccounts = async function () {
    const { data: { user } } = await sb.auth.getUser();
    if (!user) { ACC = { list: [], active: null }; return; }

    const { data: profs } = await sb.from("profiles").select("*");
    const { data: links } = await sb.from("guardians").select("parent_id,child_id");

    ACC.list = (profs || []).map(p => ({
      id: p.id, name: p.name, role: p.role, avatar: p.avatar,
      grade: p.grade, email: p.email || "", auth: { cloud: true },
      kids: (links || []).filter(l => l.parent_id === p.id).map(l => l.child_id)
    }));
    ACC.active = user.id;
  };

  window.saveAccounts = async function () {
    const a = typeof me === "function" ? me() : null;
    if (!a) return;
    await sb.from("profiles").update({
      name: a.name, avatar: a.avatar, grade: a.grade, lang: st.lang
    }).eq("id", a.id);
  };

  /* ---- signing back in with email and password ---- */
  window.cloudSignIn = async function () {
    const email = ($("#cloudEmail")?.value || "").trim().toLowerCase();
    const pw = $("#cloudPw")?.value || "";
    if (!EMAIL_RE.test(email)) { gate.err = t("emailL"); return render(); }
    if (!pw) { gate.err = t("passwordL"); return render(); }
    gate.busy = true; gate.err = "…"; render();
    const { error } = await sb.auth.signInWithPassword({ email, password: pw });
    gate.busy = false;
    if (error) { gate.err = error.message; return render(); }
    await loadAccounts();
    await loadState(ACC.active);
    gate.err = ""; gate.tab = null;
    view = "home"; render(); hud(); armIdle();
  };

  window.cloudReset = async function () {
    const email = ($("#cloudEmail")?.value || "").trim().toLowerCase();
    if (!EMAIL_RE.test(email)) { gate.err = t("resetNeedsEmail"); return render(); }
    gate.busy = true; render();
    const { error } = await sb.auth.resetPasswordForEmail(email, {
      redirectTo: location.href.split("#")[0] + "#reset"
    });
    gate.busy = false;
    gate.err = error ? error.message : t("resetSent");
    render();
  };

  /* ---- Google, for grown-ups ----
     A Google account is already verified, so a parent or admin who signs in
     this way needs no confirmation email from us. That matters because
     Supabase's "Confirm email" is a single global switch: it cannot be on for
     parents and off for children. Google gives adults verification by another
     route, so the switch can stay OFF and children sign up instantly. */
  window.signInWithGoogle = async function (role) {
    try{ sessionStorage.setItem("yet.pendingRole", role || "parent"); }catch(e){}
    const { error } = await sb.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: location.href.split("#")[0] + "#" + (role === "admin" ? "admin" : "parent"),
        queryParams: { prompt: "select_account" }
      }
    });
    if (error) toast(error.message);
  };

  /* After Google sends them back, they have an auth user but maybe no profile
     row yet. Create one, using the role they picked before they left. */
  async function ensureProfileAfterOAuth() {
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return false;
    const { data: existing } = await sb.from("profiles").select("id").eq("id", user.id).maybeSingle();
    if (existing) return true;
    let role = "parent";
    try { role = sessionStorage.getItem("yet.pendingRole") || "parent"; } catch(e) {}
    const name = (user.user_metadata && (user.user_metadata.full_name || user.user_metadata.name))
      || (user.email || "Grown-up").split("@")[0];
    const { error } = await sb.from("profiles").insert({
      id: user.id, name: String(name).slice(0, 40),
      role: role === "admin" ? "admin" : "parent",
      avatar: ROLE_EM[role] || "👪", grade: "3", lang: LANG
    });
    try { sessionStorage.removeItem("yet.pendingRole"); } catch(e) {}
    return !error;
  }

  /* ---- auth: Supabase does the hashing, server-side ---- */
  window.submitNewProfile2 = async function () {
    if (gate.busy) return;
    const name  = ($("#newName")?.value || "").trim() || "Learner";
    const email = ($("#email")?.value || "").trim().toLowerCase();
    const pw    = $("#pw")?.value || "";
    const pw2   = $("#pw2")?.value || "";
    const av    = $("#newAv")?.value || "🦊";
    const gr    = $("#newGrade")?.value || "3";
    const role  = SOLO ? BUILD : gate.role;

    if (!EMAIL_RE.test(email)) { gate.err = t("emailL"); return render(); }
    const bad = pwProblem(pw);
    if (bad) { gate.err = bad; return render(); }
    if (pw !== pw2) { gate.err = t("pwAgain"); return render(); }

    gate.busy = true; gate.err = "…"; render();
    const { data, error } = await sb.auth.signUp({ email, password: pw });
    gate.busy = false;
    if (error) { gate.err = error.message; return render(); }

    // email confirmation is on, so there may be no session yet
    if (!data.session) {
      gate.mode = "confirm"; gate.err = ""; return render();
    }

    await sb.from("profiles").insert({
      id: data.user.id, name: name.slice(0, 40),
      role: isAdult(role) ? role : "kid", avatar: isAdult(role) ? ROLE_EM[role] : av,
      grade: gr, lang: LANG
    });
    await loadAccounts();
    st = clone(DEFAULT); st.avatar = av; st.grade = gr; st.lang = LANG;
    await save();
    enterApp();
  };

  /* A Google button, shown only where it belongs: the parent and admin tabs. */
  window.googleRow = function (role) {
    if (!isAdult(role)) return "";
    return `<div style="margin:0 0 18px">
      <button class="btn btn-ghost" style="width:100%;display:flex;align-items:center;justify-content:center;gap:10px"
        onclick="signInWithGoogle('${role}')">
        <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
          <path fill="#4285F4" d="M45 24c0-1.6-.1-2.7-.4-4H24v7.5h12c-.2 2-1.5 5-4.4 7l6.7 5.2C42.2 36.2 45 30.6 45 24z"/>
          <path fill="#34A853" d="M24 46c5.9 0 10.9-2 14.5-5.3l-6.7-5.2c-1.9 1.3-4.4 2.2-7.8 2.2-6 0-11-4-12.8-9.4l-7 5.4C7.9 41 15.4 46 24 46z"/>
          <path fill="#FBBC05" d="M11.2 28.3A13.9 13.9 0 0 1 10.5 24c0-1.5.3-3 .7-4.3l-7-5.4A22 22 0 0 0 2 24c0 3.5.9 6.9 2.2 9.7l7-5.4z"/>
          <path fill="#EA4335" d="M24 10.2c3.4 0 5.7 1.5 7 2.7l5.9-5.7C33.3 3.7 29.4 2 24 2 15.4 2 7.9 7 4.2 14.3l7 5.4C13 14.2 18 10.2 24 10.2z"/>
        </svg>
        ${t("googleBtn")}
      </button>
      <p class="hint" style="text-align:center;margin-top:8px">${t("googleWhy")}</p>
      <div style="display:flex;align-items:center;gap:12px;margin:16px 0 0">
        <span style="flex:1;height:2px;background:var(--line)"></span>
        <span class="mono" style="font-size:11px;color:var(--muted);letter-spacing:.1em">${t("orWord")}</span>
        <span style="flex:1;height:2px;background:var(--line)"></span>
      </div></div>`;
  };

  window.gateSignIn = async function () {
    const a = ACC.list.find(x => x.id === gate.pick);
    const email = a ? a.email : ($("#email")?.value || "");
    const pw = $("#pw")?.value || "";
    gate.busy = true; gate.err = "…"; render();
    const { error } = await sb.auth.signInWithPassword({ email, password: pw });
    gate.busy = false;
    if (error) { gate.err = error.message; render(); return shakePin(); }
    await loadAccounts();
    await loadState(ACC.active);
    gate.pick = null; gate.mode = "list";
    view = "home"; render(); armIdle(); runPending();
  };

  /* a real reset email, instead of a recovery code the child must keep */
  window.gateForgot = async function () {
    const email = ($("#email")?.value || "").trim().toLowerCase();
    if (!EMAIL_RE.test(email)) { gate.err = t("emailL"); return render(); }
    gate.busy = true; render();
    const { error } = await sb.auth.resetPasswordForEmail(email, {
      redirectTo: location.href.split("#")[0] + "#reset"
    });
    gate.busy = false;
    gate.err = error ? error.message : t("resetSent");
    render();
  };

  window.signOut = async function () {
    stopClock(); sess = null;
    await flushQueue();
    await sb.auth.signOut();
    ACC = { list: [], active: null };
    st = clone(DEFAULT);
    view = adultBuild ? "accounts" : "home";
    render(); hud();
  };

  /* ---- switching profiles now means signing in as them ---- */
  window.switchAccount = async function (id, verified) {
    const a = ACC.list.find(x => x.id === id);
    if (!a) return;
    if (id === ACC.active) return;
    gate.pick = id; gate.mode = "signin"; view = "accounts"; render();
  };

  /* ---- the link code: how a parent claims a child across devices ---- */
  window.makeLinkCode = async function () {
    const { data, error } = await sb.rpc("make_link_code");
    if (error) return toast(error.message);
    gate.linkCode = data;
    render();
    return data;
  };

  window.claimChild = async function () {
    const code = (prompt(t("enterLinkCode")) || "").trim();
    if (!code) return;
    const { error } = await sb.rpc("claim_child", { p_code: code });
    if (error) return toast(error.message);
    await loadAccounts();
    ROSTER = [];
    toast(t("childLinked"));
    render();
  };

  /* ---- the roster reads straight from the database ---- */
  window.loadRoster = async function () {
    ADMIN.busy = true;
    const { data } = await sb
      .from("learner_state").select("profile_id,state,updated_at");
    const states = {};
    (data || []).forEach(r => { states[r.profile_id] = r.state; });
    ROSTER = ACC.list
      .filter(a => (a.role || "kid") === "kid")
      .filter(a => roleOf() === "admin" || (me()?.kids || []).includes(a.id))
      .map(a => ({ a, s: Object.assign(clone(DEFAULT), states[a.id] || {}) }));
    ADMIN.busy = false;
    if (view === "home") render();
  };

  /* ---- assignments live in their own table now ---- */
  window.adminAssign = async function (skillId) {
    const ids = ADMIN.target === "all" ? assignScope().map(a => a.id) : [ADMIN.target];
    for (const id of ids) {
      await sb.from("assignments").insert({ child_id: id, skill_id: skillId, assigned_by: ACC.active });
    }
    await loadRoster(); render(); go("assign");
    toast(t("assign"));
  };

  window.adminUnassign = async function (skillId, who) {
    const ids = who ? [who] : (ADMIN.target === "all" ? assignScope().map(a => a.id) : [ADMIN.target]);
    for (const id of ids) {
      await sb.from("assignments").delete().eq("child_id", id).eq("skill_id", skillId);
    }
    await loadRoster(); render(); go("assign");
  };

  window.loadAssignments = async function () {
    if (!ACC.active) return;
    const { data } = await sb.from("assignments").select("skill_id").eq("child_id", ACC.active);
    st.assigned = (data || []).map(r => r.skill_id);
  };

  /* ---- log every answer: this is how you find badly-graded skills ---- */
  const origAnswer = window.answer;
  window.answer = function (idx) {
    const before = sess ? sess.right : 0;
    const skill  = sess && sess.skill ? sess.skill.id : null;
    const t0     = sess && sess.qt ? sess.qt : Date.now();
    const out = origAnswer.apply(this, arguments);
    if (skill && ACC.active && roleOf() === "kid") {
      sb.from("answers").insert({
        profile_id: ACC.active, skill_id: skill,
        correct: sess ? sess.right > before : false,
        ms: Math.min(600000, Date.now() - t0)
      }).then(() => {}, () => {});     // fire and forget; never block the child
    }
    return out;
  };

  /* ---- account deletion that really deletes ---- */
  window.deleteMyAccount = async function () {
    if (!confirm(t("eraseAll"))) return;
    await sb.rpc("delete_my_account");
    await sb.auth.signOut();
    location.reload();
  };

  /* ---- start ---- */
  flushQueue();
  (async () => {
    const { data: { session } } = await sb.auth.getSession();
    if (session) {
      const okp = await ensureProfileAfterOAuth();
      if (okp) { await loadAccounts(); await loadState(ACC.active); view = "home"; render(); hud(); }
    }
  })();
  sb.auth.onAuthStateChange((event) => {
    if (event === "SIGNED_OUT") { ACC = { list: [], active: null }; st = clone(DEFAULT); render(); }
  });
}
