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
  sb.auth.onAuthStateChange((event) => {
    if (event === "SIGNED_OUT") { ACC = { list: [], active: null }; st = clone(DEFAULT); render(); }
  });
}
