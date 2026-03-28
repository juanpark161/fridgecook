// @ts-nocheck
import { useState, useRef, useEffect, useCallback } from "react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from "recharts";

// Stripe — loaded via CDN in useEffect
// Set your keys as env vars: VITE_STRIPE_PUBLISHABLE_KEY, VITE_STRIPE_WEEKLY_PRICE_ID, VITE_STRIPE_YEARLY_PRICE_ID
const STRIPE_KEY  = import.meta.env?.VITE_STRIPE_PUBLISHABLE_KEY || "";
const PRICE_WEEK  = import.meta.env?.VITE_STRIPE_WEEKLY_PRICE_ID  || "";
const PRICE_YEAR  = import.meta.env?.VITE_STRIPE_YEARLY_PRICE_ID  || "";

// Pricing
const PLANS = {
  weekly: { id: "weekly", label: "Weekly",  price: 2.99,  period: "week",  trialDays: 1, priceId: PRICE_WEEK, perMonth: 12.96 },
  yearly: { id: "yearly", label: "Annual",  price: 89.99, period: "year",  trialDays: 1, priceId: PRICE_YEAR, perMonth: 7.49, savings: "42%" },
};

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function toBase64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result.split(",")[1]);
    r.onerror = () => rej(new Error("Read failed"));
    r.readAsDataURL(file);
  });
}

async function callClaude(messages, systemPrompt, model = "claude-haiku-4-5-20251001", max_tokens = 500) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, max_tokens, system: systemPrompt, messages }),
  });
  const data = await res.json();
  return data.content?.[0]?.text || "";
}

function calcTDEE({ weight, height, age, sex, goal, activityLevel }) {
  const w = parseFloat(weight), h = parseFloat(height), a = parseFloat(age);
  if (!w || !h || !a) return 2000;
  const bmr = sex === "female"
    ? 10 * w + 6.25 * h - 5 * a - 161
    : 10 * w + 6.25 * h - 5 * a + 5;
  const mult = { sedentary: 1.2, light: 1.375, moderate: 1.55, active: 1.725 };
  const tdee = bmr * (mult[activityLevel] || 1.375);
  if (goal === "muscle") return Math.round(tdee + 300);
  if (goal === "fat")    return Math.round(tdee - 500);
  return Math.round(tdee);
}

// ─────────────────────────────────────────────────────────────────────────────
// SUBSCRIPTION STORAGE  (mocked — in production replace with Stripe + backend)
// ─────────────────────────────────────────────────────────────────────────────
// sub shape: { status, trialStart, paidStart, paidEnd, cardLast4, cancelled }
// status: "none" | "trial" | "paid" | "expired"

const SUB_KEY = "fridgecook_sub_v2";

function readSub() {
  try { return JSON.parse(localStorage.getItem(SUB_KEY)) || { status: "none" }; }
  catch { return { status: "none" }; }
}
function writeSub(sub) {
  try { localStorage.setItem(SUB_KEY, JSON.stringify(sub)); } catch {}
}

// Derive runtime state from stored sub
function evalSub(sub) {
  const now = Date.now();
  if (sub.status === "trial") {
    const elapsed = now - sub.trialStart;
    const remaining = 24 * 3600 * 1000 - elapsed;
    if (sub.cancelled || remaining <= 0) return { ...sub, status: "expired", active: false, hoursLeft: 0 };
    return { ...sub, active: true, hoursLeft: Math.ceil(remaining / 3600000) };
  }
  if (sub.status === "paid") {
    if (sub.cancelled && now > sub.paidEnd) return { ...sub, status: "expired", active: false };
    if (!sub.cancelled && now > sub.paidEnd) {
      // Auto-renew (mock)
      const renewed = { ...sub, paidStart: sub.paidEnd, paidEnd: sub.paidEnd + 30 * 24 * 3600 * 1000 };
      writeSub(renewed);
      return { ...renewed, active: true };
    }
    return { ...sub, active: true };
  }
  return { ...sub, active: false };
}

function daysLeftPaid(sub) {
  if (sub.status !== "paid") return 0;
  return Math.max(0, Math.ceil((sub.paidEnd - Date.now()) / 86400000));
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN APP
// ─────────────────────────────────────────────────────────────────────────────

export default function FridgeCook() {
  const [tab, setTab]       = useState("home");   // home | meals | pro
  const [screen, setScreen] = useState("home");   // home | suggestions | recipe
  const [sub, setSub]       = useState(() => evalSub(readSub()));

  // Modals
  const [modal, setModal]           = useState(null);
  const [selectedPlan, setSelectedPlan] = useState("weekly"); // "weekly" | "yearly"

  // Profile
  const [profile, setProfile] = useState({
    weight: "", height: "", age: "", sex: "male",
    goal: "maintain", activityLevel: "moderate", profileDone: false,
  });

  // Fridge / meals
  const [imagePreview, setImagePreview] = useState(null);
  const [suggestions,  setSuggestions]  = useState([]);
  const [selectedMeal, setSelectedMeal] = useState(null);
  const [recipe,       setRecipe]       = useState(null);
  const [loading,      setLoading]      = useState(false);
  const [loadingMsg,   setLoadingMsg]   = useState("");
  const [mealLog,      setMealLog]      = useState([]);
  const [calorieGoal,  setCalorieGoal]  = useState(2000);
  const [dragOver,     setDragOver]     = useState(false);

  // Notification queue
  const [notification, setNotification] = useState(null);

  // Scanning live estimator
  const [scanElapsed, setScanElapsed] = useState(null); // secs since start
  const [scanETA,     setScanETA]     = useState(null); // live ETA in secs
  const scanTimerRef   = useRef(null);
  const scanStartRef   = useRef(null);
  const scanAbortRef   = useRef(null);
  const scanHistoryRef = useRef([14, 17, 13]); // rolling past durations (secs)

  const fileRef   = useRef();
  const cameraRef = useRef();

  const proActive = sub.active;

  // ── Sync calorie goal with profile ───────────────────────────────────────
  useEffect(() => {
    if (profile.profileDone) setCalorieGoal(calcTDEE(profile));
  }, [profile]);

  // ── Poll sub every minute to catch trial expiry ───────────────────────────
  useEffect(() => {
    const id = setInterval(() => {
      const fresh = evalSub(readSub());
      setSub(fresh);
      // Notify when trial just expired
      if (fresh.status === "expired" && fresh.trialStart && !fresh.notified) {
        const stored = readSub();
        writeSub({ ...stored, notified: true });
        setNotification({ type: "trialEnd", msg: "Your free trial has ended. Upgrade to keep Pro access!" });
        setModal("notify");
      }
      // Notify when paid period about to charge (mock: when 0 days left)
      if (fresh.status === "paid" && !fresh.cancelled && daysLeftPaid(fresh) === 0 && !fresh.chargeNotified) {
        const stored = readSub();
        writeSub({ ...stored, chargeNotified: true });
        const _s = readSub(); const _p = PLANS[_s.planId] || PLANS.weekly;
        setNotification({ type: "charge", msg: `💳 Your Pro subscription renewed for $${_p.price}/${_p.period}. Thanks for being a FridgeCook Pro member!` });
        setModal("notify");
      }
    }, 60000);
    return () => clearInterval(id);
  }, []);

  // ── Subscribe actions ─────────────────────────────────────────────────────
  function startTrial(cardLast4, planId) {
    const plan = PLANS[planId] || PLANS.weekly;
    const newSub = { status: "trial", trialStart: Date.now(), cardLast4, planId, cancelled: false };
    writeSub(newSub);
    setSub(evalSub(newSub));
    setModal("profile");
  }

  function activatePaid(cardLast4) {
    const now = Date.now();
    const newSub = { status: "paid", paidStart: now, paidEnd: now + 30 * 24 * 3600 * 1000, cardLast4, cancelled: false };
    writeSub(newSub);
    setSub(evalSub(newSub));
    setModal("profile");
  }

  function cancelSub() {
    const stored = readSub();
    const updated = { ...stored, cancelled: true };
    writeSub(updated);
    const fresh = evalSub(updated);
    setSub(fresh);
  }

  // ── Upload / Analyze ──────────────────────────────────────────────────────
  // ── Scan estimator ───────────────────────────────────────────────────────
  // Produces a live ETA using a rolling average of actual past durations.
  // ETA = rollingAvg - elapsed. Once elapsed > avg we extend by ~3s/tick.

  function rollingAvg() {
    const h = scanHistoryRef.current;
    return Math.round(h.reduce((a, b) => a + b, 0) / h.length);
  }

  function startScanEstimator() {
    scanStartRef.current = Date.now();
    const eta = rollingAvg();
    setScanElapsed(0);
    setScanETA(eta);
    clearInterval(scanTimerRef.current);
    scanTimerRef.current = setInterval(() => {
      const elapsed = Math.round((Date.now() - scanStartRef.current) / 1000);
      setScanElapsed(elapsed);
      setScanETA(() => {
        const avg = rollingAvg();
        if (elapsed >= avg) return elapsed + 3; // extend gracefully
        return avg - elapsed;
      });
    }, 1000);
  }

  function stopScanEstimator(actualSecs) {
    clearInterval(scanTimerRef.current);
    if (actualSecs > 0) {
      scanHistoryRef.current = [...scanHistoryRef.current.slice(-5), actualSecs];
    }
    setScanElapsed(null);
    setScanETA(null);
  }

  async function handleFile(file) {
    if (!file) return;
    const b64 = await toBase64(file);
    setImagePreview(URL.createObjectURL(file));
    setLoading(true);
    setLoadingMsg("Scanning your fridge…");
    startScanEstimator();

    const controller = new AbortController();
    scanAbortRef.current = controller;
    const timeoutId = setTimeout(() => controller.abort(), 60 * 1000);
    const t0 = Date.now();

    try {
      const count = proActive ? 10 : 6;
      const calNote = proActive ? 'Also include "calories" (number, per serving) and "macros": {"protein":X,"carbs":X,"fat":X}.' : "";
      const goalNote = profile.profileDone
        ? `User goal: ${profile.goal === "muscle" ? "build muscle (high protein)" : profile.goal === "fat" ? "lose fat (low calorie)" : "maintain"}.`
        : "";
      const system = `You are a helpful chef AI. Respond ONLY with valid JSON, no markdown.`;
      const prompt = `List ${count} meals from this fridge. JSON array only, keys: "name","time","difficulty","emoji". ${calNote} ${goalNote}`;

      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 400,
          system,
          messages: [{
            role: "user", content: [
              { type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64 } },
              { type: "text", text: prompt },
            ],
          }],
        }),
      });
      const data = await res.json();
      const raw = data.content?.[0]?.text || "";
      setSuggestions(JSON.parse(raw.replace(/```json|```/g, "").trim()));
      setScreen("suggestions"); setTab("meals");
    } catch (err) {
      if (err.name === "AbortError") {
        alert("Scanning timed out. Please try again.");
      } else {
        alert("Couldn't analyze the image. Please try again.");
      }
    } finally {
      clearTimeout(timeoutId);
      stopScanEstimator(Math.round((Date.now() - t0) / 1000));
      setLoading(false);
    }
  }

  function onFileInput(e) { handleFile(e.target.files[0]); }
  function onDrop(e) { e.preventDefault(); setDragOver(false); handleFile(e.dataTransfer.files[0]); }

  // ── Recipe ────────────────────────────────────────────────────────────────
  async function fetchRecipe(meal) {
    setSelectedMeal(meal); setRecipe(null); setScreen("recipe");
    setLoading(true); setLoadingMsg("Generating recipe…");
    try {
      const calNote = proActive ? 'Include "calories" (per serving), "macros": {"protein":X,"carbs":X,"fat":X}.' : "";
      const goalNote = profile.profileDone ? `User goal: ${profile.goal}.` : "";
      const raw = await callClaude([{ role: "user", content: `Recipe for "${meal.name}". JSON only: "ingredients","steps","servings","totalTime". ${calNote} ${goalNote}` }],
        `You are a helpful chef AI. Respond ONLY with compact valid JSON, no markdown, no extra text.`, "claude-haiku-4-5-20251001", 600);
      setRecipe(JSON.parse(raw.replace(/```json|```/g, "").trim()));
    } catch { alert("Couldn't fetch recipe."); }
    finally { setLoading(false); }
  }

  function logMeal() {
    const cal = recipe?.calories || selectedMeal?.calories || 0;
    setMealLog(p => [...p, { name: selectedMeal.name, calories: cal, date: new Date().toLocaleDateString() }]);
    setNotification({ type: "logged", msg: `✅ "${selectedMeal.name}" logged — ${cal} kcal` });
    setModal("notify");
  }

  // ── Dashboard chart data ──────────────────────────────────────────────────
  function getDashboardData() {
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(); d.setDate(d.getDate() - (6 - i));
      const dateStr = d.toLocaleDateString();
      return { day: d.toLocaleDateString("en-US", { weekday: "short" }), calories: mealLog.filter(m => m.date === dateStr).reduce((s, m) => s + (m.calories || 0), 0) };
    });
  }
  const todayStr      = new Date().toLocaleDateString();
  const todayCalories = mealLog.filter(m => m.date === todayStr).reduce((s, m) => s + (m.calories || 0), 0);

  // ─────────────────────────────────────────────────────────────────────────
  // STYLES
  // ─────────────────────────────────────────────────────────────────────────
  const S = `
    @import url('https://fonts.googleapis.com/css2?family=Fraunces:ital,wght@0,400;0,600;0,700;1,400&family=DM+Sans:wght@300;400;500;600&display=swap');
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'DM Sans', sans-serif; background: #f9f8ff; color: #1a1a1a; min-height: 100vh; }

    .app { max-width: 480px; margin: 0 auto; min-height: 100vh; background: #f9f8ff; display: flex; flex-direction: column; position: relative; }
    .app-body { flex: 1; overflow-y: auto; padding-bottom: 90px; }

    /* ── DOCK ── */
    .dock {
      position: fixed; bottom: 0; left: 50%; transform: translateX(-50%);
      width: 100%; max-width: 480px;
      background: rgba(255,255,255,0.92);
      backdrop-filter: blur(16px);
      border-top: 1px solid #e8e4f5;
      display: flex; align-items: stretch;
      z-index: 50; padding: 0 8px;
      padding-bottom: env(safe-area-inset-bottom, 0px);
    }
    .dock-item {
      flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center;
      padding: 10px 4px 12px; gap: 4px; cursor: pointer; border: none; background: none;
      font-family: 'DM Sans', sans-serif; transition: all 0.15s; border-radius: 12px; margin: 6px 2px;
    }
    .dock-item:hover { background: #f5f0fe; }
    .dock-icon { font-size: 22px; line-height: 1; transition: transform 0.15s; }
    .dock-item:hover .dock-icon { transform: translateY(-2px); }
    .dock-label { font-size: 11px; font-weight: 500; color: #aaa; letter-spacing: 0.2px; }
    .dock-item.active .dock-label { color: #7C3AED; font-weight: 600; }
    .dock-item.active .dock-icon { filter: none; }
    .dock-dot { width: 4px; height: 4px; background: #7C3AED; border-radius: 50%; position: absolute; bottom: 6px; }
    .dock-pip { width: 5px; height: 5px; background: #7C3AED; border-radius: 50%; margin-top: -2px; }

    /* ── NAV ── */
    .nav { display: flex; align-items: center; justify-content: space-between; padding: 18px 24px 14px; border-bottom: 1px solid #e8e4f5; background: #f9f8ff; position: sticky; top: 0; z-index: 20; }
    .nav-logo { font-family: 'Fraunces', serif; font-size: 22px; font-weight: 700; letter-spacing: -0.5px; }
    .nav-logo span { color: #7C3AED; }
    .nav-right { display: flex; align-items: center; gap: 8px; }
    .back-btn { background: none; border: none; font-size: 20px; cursor: pointer; padding: 4px 8px; border-radius: 8px; color: #555; }
    .back-btn:hover { background: #e8e4f5; }
    .icon-btn { background: none; border: 1.5px solid #e8e4f5; border-radius: 8px; padding: 5px 9px; font-size: 15px; cursor: pointer; transition: all 0.15s; }
    .icon-btn:hover { background: #f5f0fe; border-color: #c4b5fd; }
    .status-pill { font-size: 11px; font-weight: 600; padding: 5px 11px; border-radius: 20px; letter-spacing: 0.3px; white-space: nowrap; }
    .pill-trial { background: #f5f0fe; color: #7C3AED; border: 1.5px solid #c4b5fd; }
    .pill-paid  { background: #7C3AED; color: #fff; }
    .pill-none  { background: transparent; color: #999; border: 1.5px solid #ddd; cursor: pointer; }
    .pill-none:hover { border-color: #7C3AED; color: #7C3AED; }

    /* ── HOME ── */
    .home-hero { padding: 40px 24px 24px; text-align: center; }
    .home-hero h1 { font-family: 'Fraunces', serif; font-size: 36px; font-weight: 700; line-height: 1.15; margin-bottom: 12px; }
    .home-hero h1 em { color: #7C3AED; font-style: italic; }
    .home-hero p { color: #666; font-size: 15px; line-height: 1.6; font-weight: 300; }

    .upload-zone { margin: 8px 24px 24px; border: 2px dashed #d4cef0; border-radius: 20px; padding: 40px 24px; text-align: center; transition: all 0.2s; background: #fff; }
    .upload-zone.drag { border-color: #7C3AED; background: #f5f0fe; }
    .upload-icon { font-size: 44px; margin-bottom: 12px; display: block; }
    .upload-zone h3 { font-family: 'Fraunces', serif; font-size: 18px; margin-bottom: 6px; }
    .upload-zone > p { font-size: 13px; color: #888; }
    .upload-btn-row { display: flex; gap: 10px; margin-top: 16px; justify-content: center; }
    .upload-btn { background: #1a1a1a; color: #fff; border: none; padding: 12px 20px; border-radius: 12px; font-size: 14px; font-weight: 500; cursor: pointer; font-family: 'DM Sans', sans-serif; transition: all 0.2s; }
    .upload-btn:hover { background: #7C3AED; }
    .upload-btn.cam { background: #fff; color: #1a1a1a; border: 1.5px solid #d4cef0; }
    .upload-btn.cam:hover { border-color: #7C3AED; color: #7C3AED; background: #f5f0fe; }

    /* ── PRO TAB ── */
    .pro-page { padding: 24px; }
    .pro-page h2 { font-family: 'Fraunces', serif; font-size: 28px; font-weight: 700; margin-bottom: 4px; }
    .pro-page .sub { color: #888; font-size: 14px; margin-bottom: 28px; }

    .plan-card { border-radius: 20px; padding: 24px; margin-bottom: 16px; }
    .plan-card.active { background: linear-gradient(135deg, #1e1040 0%, #3b1f7a 100%); color: #fff; }
    .plan-card.inactive { background: #fff; border: 1.5px solid #e8e4f5; }
    .plan-badge { display: inline-block; font-size: 11px; font-weight: 600; padding: 4px 10px; border-radius: 20px; margin-bottom: 12px; letter-spacing: 0.4px; text-transform: uppercase; }
    .plan-badge.pro { background: rgba(167,139,250,0.25); color: #c4b5fd; }
    .plan-badge.free { background: #f0eefe; color: #7C3AED; }
    .plan-name { font-family: 'Fraunces', serif; font-size: 22px; font-weight: 700; margin-bottom: 4px; }
    .plan-price { font-size: 32px; font-weight: 700; font-family: 'Fraunces', serif; }
    .plan-price span { font-size: 15px; font-weight: 400; opacity: 0.7; }
    .plan-desc { font-size: 13px; opacity: 0.75; margin-top: 6px; line-height: 1.5; }
    .plan-features { margin-top: 16px; display: flex; flex-direction: column; gap: 8px; }
    .plan-feat { font-size: 13px; display: flex; gap: 8px; align-items: flex-start; }
    .plan-feat .ck { color: #a78bfa; flex-shrink: 0; }
    .plan-feat .ck.gray { color: #aaa; }
    .plan-actions { margin-top: 20px; display: flex; flex-direction: column; gap: 8px; }
    .btn-primary { background: #7C3AED; color: #fff; border: none; width: 100%; padding: 14px; border-radius: 12px; font-size: 14px; font-weight: 600; cursor: pointer; font-family: 'DM Sans', sans-serif; transition: background 0.2s; }
    .btn-primary:hover { background: #5B21B6; }
    .btn-primary.white { background: #fff; color: #7C3AED; }
    .btn-primary.white:hover { background: #f5f0fe; }
    .btn-danger { background: none; color: #e55; border: 1.5px solid #fcc; width: 100%; padding: 13px; border-radius: 12px; font-size: 14px; font-weight: 500; cursor: pointer; font-family: 'DM Sans', sans-serif; transition: all 0.2s; }
    .btn-danger:hover { background: #fff5f5; border-color: #e55; }
    .btn-ghost { background: none; color: #888; border: 1.5px solid #e8e4f5; width: 100%; padding: 13px; border-radius: 12px; font-size: 14px; cursor: pointer; font-family: 'DM Sans', sans-serif; }
    .card-hint { font-size: 12px; color: #aaa; display: flex; align-items: center; gap: 6px; margin-top: 12px; }

    .sub-info-row { display: flex; justify-content: space-between; font-size: 13px; padding: 10px 0; border-bottom: 1px solid #f0eefe; }
    .sub-info-row:last-child { border-bottom: none; }
    .sub-info-label { color: #888; }
    .sub-info-val { font-weight: 600; }

    /* ── MEALS TAB ── */
    .section-header { padding: 22px 24px 14px; }
    .section-header h2 { font-family: 'Fraunces', serif; font-size: 26px; font-weight: 700; margin-bottom: 4px; }
    .section-header p { color: #888; font-size: 13px; }
    .fridge-thumb { margin: 0 24px 16px; border-radius: 14px; overflow: hidden; height: 130px; }
    .fridge-thumb img { width: 100%; height: 100%; object-fit: cover; }
    .goal-banner { margin: 0 24px 16px; background: #f5f0fe; border: 1px solid #c4b5fd; border-radius: 12px; padding: 10px 14px; font-size: 13px; color: #7C3AED; display: flex; align-items: center; gap: 8px; }
    .meal-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; padding: 0 24px 32px; }
    .meal-card { background: #fff; border: 1.5px solid #e8e4f5; border-radius: 16px; padding: 16px; cursor: pointer; transition: all 0.2s; }
    .meal-card:hover { border-color: #7C3AED; transform: translateY(-2px); box-shadow: 0 8px 24px rgba(124,58,237,0.1); }
    .meal-emoji { font-size: 30px; margin-bottom: 10px; display: block; }
    .meal-name { font-family: 'Fraunces', serif; font-size: 15px; font-weight: 600; margin-bottom: 8px; line-height: 1.3; }
    .meal-tag { font-size: 11px; color: #888; }
    .meal-calories { font-size: 12px; color: #7C3AED; font-weight: 500; margin-top: 6px; }
    .empty-meals { text-align: center; padding: 80px 24px; }
    .empty-meals .big { font-size: 52px; margin-bottom: 16px; }
    .empty-meals h3 { font-family: 'Fraunces', serif; font-size: 22px; margin-bottom: 8px; }
    .empty-meals p { color: #888; font-size: 14px; line-height: 1.6; }

    /* ── RECIPE ── */
    .recipe-header { padding: 22px 24px; background: #fff; border-bottom: 1px solid #e8e4f5; }
    .recipe-emoji { font-size: 48px; margin-bottom: 10px; display: block; }
    .recipe-title { font-family: 'Fraunces', serif; font-size: 26px; font-weight: 700; line-height: 1.2; margin-bottom: 12px; }
    .chips { display: flex; gap: 8px; flex-wrap: wrap; }
    .chip { font-size: 12px; padding: 5px 12px; background: #f9f8ff; border: 1px solid #e8e4f5; border-radius: 20px; color: #555; }
    .chip.accent { background: #f5f0fe; border-color: #c4b5fd; color: #7C3AED; }
    .macros-card { margin: 16px 24px 0; background: #fff; border: 1.5px solid #e8e4f5; border-radius: 16px; padding: 16px; }
    .macros-card h4 { font-size: 11px; color: #aaa; text-transform: uppercase; letter-spacing: 0.6px; margin-bottom: 12px; }
    .macros-row { display: flex; gap: 12px; }
    .macro-item { flex: 1; text-align: center; }
    .macro-val { font-family: 'Fraunces', serif; font-size: 22px; font-weight: 700; }
    .macro-lbl { font-size: 11px; color: #888; margin-top: 2px; }
    .recipe-body { padding: 20px 24px; }
    .recipe-body h3 { font-family: 'Fraunces', serif; font-size: 18px; margin-bottom: 12px; }
    .ingredient-list { list-style: none; display: flex; flex-direction: column; gap: 8px; margin-bottom: 24px; }
    .ingredient-list li { padding: 10px 14px; background: #fff; border: 1px solid #e8e4f5; border-radius: 10px; font-size: 14px; display: flex; align-items: center; gap: 8px; }
    .ingredient-list li::before { content: "·"; color: #7C3AED; font-size: 18px; }
    .step-list { list-style: none; display: flex; flex-direction: column; gap: 12px; margin-bottom: 28px; }
    .step-item { display: flex; gap: 14px; }
    .step-num { width: 28px; height: 28px; min-width: 28px; background: #1a1a1a; color: #fff; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 600; margin-top: 1px; }
    .step-text { font-size: 14px; line-height: 1.65; color: #333; padding-top: 3px; }
    .log-btn { display: block; margin: 0 24px 40px; width: calc(100% - 48px); background: #7C3AED; color: #fff; border: none; padding: 15px; border-radius: 14px; font-size: 15px; font-weight: 500; cursor: pointer; font-family: 'DM Sans', sans-serif; transition: background 0.2s; }
    .log-btn:hover { background: #5B21B6; }

    /* ── DASHBOARD (inside pro tab) ── */
    .dash-section { padding: 0 24px 24px; }
    .dash-section h3 { font-family: 'Fraunces', serif; font-size: 18px; margin-bottom: 14px; }
    .goal-card { background: #fff; border: 1.5px solid #e8e4f5; border-radius: 16px; padding: 18px; margin-bottom: 16px; }
    .goal-val { font-family: 'Fraunces', serif; font-size: 28px; font-weight: 700; }
    .goal-val span { font-size: 14px; color: #888; font-family: 'DM Sans', sans-serif; font-weight: 300; }
    .progress-bar { height: 8px; background: #e8e4f5; border-radius: 4px; overflow: hidden; margin-top: 12px; }
    .progress-fill { height: 100%; background: #7C3AED; border-radius: 4px; transition: width 0.5s; }
    .chart-wrap { background: #fff; border: 1.5px solid #e8e4f5; border-radius: 16px; padding: 16px; }
    .log-list { display: flex; flex-direction: column; gap: 8px; }
    .log-item { display: flex; justify-content: space-between; align-items: center; padding: 12px 14px; background: #fff; border: 1px solid #e8e4f5; border-radius: 12px; }
    .log-item-name { font-size: 14px; font-weight: 500; }
    .log-item-cal { font-size: 13px; color: #7C3AED; font-weight: 500; }
    .log-item-date { font-size: 11px; color: #aaa; margin-top: 2px; }
    .empty-state { text-align: center; color: #bbb; font-size: 14px; padding: 28px 0; line-height: 1.8; }

    /* ── LOADING ── */
    .loading-screen { display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 60vh; gap: 20px; }
    .spinner { width: 40px; height: 40px; border: 3px solid #e8e4f5; border-top-color: #7C3AED; border-radius: 50%; animation: spin 0.8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .loading-screen p { color: #888; font-size: 14px; }

    /* ── MODALS ── */
    .overlay { position: fixed; inset: 0; background: rgba(10,0,30,0.5); z-index: 200; display: flex; align-items: flex-end; justify-content: center; animation: fadeIn 0.2s; }
    @keyframes fadeIn { from { opacity: 0; } }
    .sheet { background: #fff; border-radius: 24px 24px 0 0; padding: 28px 24px 44px; width: 100%; max-width: 480px; animation: slideUp 0.25s ease; max-height: 92vh; overflow-y: auto; }
    @keyframes slideUp { from { transform: translateY(40px); opacity: 0; } }
    .handle { width: 36px; height: 4px; background: #e8e4f5; border-radius: 2px; margin: 0 auto 22px; }
    .sheet h2 { font-family: 'Fraunces', serif; font-size: 26px; font-weight: 700; margin-bottom: 8px; }
    .sheet > p { font-size: 14px; color: #666; line-height: 1.6; margin-bottom: 20px; }

    /* payment form */
    .pay-form { display: flex; flex-direction: column; gap: 12px; margin-bottom: 20px; }
    .pay-field { display: flex; flex-direction: column; gap: 6px; }
    .pay-field label { font-size: 11px; font-weight: 600; color: #999; text-transform: uppercase; letter-spacing: 0.5px; }
    .pay-field input { padding: 13px 14px; border: 1.5px solid #e8e4f5; border-radius: 10px; font-size: 15px; font-family: 'DM Sans', sans-serif; }
    .pay-field input:focus { outline: none; border-color: #7C3AED; }
    .pay-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .pay-security { display: flex; align-items: center; gap: 8px; font-size: 12px; color: #aaa; margin-bottom: 16px; }
    .pay-summary { background: #f5f0fe; border-radius: 12px; padding: 14px; margin-bottom: 20px; font-size: 13px; color: #555; line-height: 1.7; }
    .pay-summary strong { color: #7C3AED; }

    /* profile form */
    .profile-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 16px; }
    .field { display: flex; flex-direction: column; gap: 6px; }
    .field.full { grid-column: 1 / -1; }
    .field label { font-size: 11px; font-weight: 600; color: #999; text-transform: uppercase; letter-spacing: 0.5px; }
    .field input, .field select { padding: 11px 14px; border: 1.5px solid #e8e4f5; border-radius: 10px; font-size: 14px; font-family: 'DM Sans', sans-serif; background: #fff; }
    .field input:focus, .field select:focus { outline: none; border-color: #7C3AED; }
    .goal-opts { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; margin: 8px 0 16px; }
    .goal-opt { padding: 14px 6px 10px; border: 1.5px solid #e8e4f5; border-radius: 12px; text-align: center; cursor: pointer; font-size: 12px; color: #555; background: #fff; transition: all 0.15s; }
    .goal-opt:hover { border-color: #c4b5fd; }
    .goal-opt.sel { border-color: #7C3AED; background: #f5f0fe; color: #7C3AED; font-weight: 600; }
    .goal-opt .gi { font-size: 24px; display: block; margin-bottom: 6px; }
    .tdee-hint { font-size: 13px; color: #7C3AED; background: #f5f0fe; border-radius: 10px; padding: 12px 14px; margin-bottom: 16px; line-height: 1.5; }
    .save-btn { background: #1a1a1a; color: #fff; border: none; width: 100%; padding: 15px; border-radius: 14px; font-size: 15px; font-weight: 500; cursor: pointer; font-family: 'DM Sans', sans-serif; transition: background 0.2s; }
    .save-btn:hover { background: #7C3AED; }

    /* notification toast */
    .notify-sheet { background: #fff; border-radius: 24px 24px 0 0; padding: 32px 24px 48px; width: 100%; max-width: 480px; animation: slideUp 0.25s ease; text-align: center; }
    .notify-icon { font-size: 52px; margin-bottom: 16px; display: block; }
    .notify-sheet h3 { font-family: 'Fraunces', serif; font-size: 22px; margin-bottom: 8px; }
    .notify-sheet p { font-size: 14px; color: #666; line-height: 1.6; margin-bottom: 24px; }

    /* cancel confirm */
    .cancel-box { background: #fff5f5; border: 1.5px solid #fcc; border-radius: 14px; padding: 16px; margin-bottom: 16px; font-size: 13px; color: #c00; line-height: 1.6; }
  `;

  // ─────────────────────────────────────────────────────────────────────────
  // MODAL COMPONENTS
  // ─────────────────────────────────────────────────────────────────────────

  function UpgradeSheet() {
    const plan = PLANS[selectedPlan];
    return (
      <div className="overlay" onClick={() => setModal(null)}>
        <div className="sheet" onClick={e => e.stopPropagation()}>
          <div className="handle" />
          <h2>Unlock FridgeCook Pro ✦</h2>
          <p>Try free for 24 hours — no charge until your trial ends. Cancel anytime.</p>

          {/* Plan picker */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 20 }}>
            {Object.values(PLANS).map(p => (
              <div key={p.id} onClick={() => setSelectedPlan(p.id)}
                style={{ border: `2px solid ${selectedPlan === p.id ? "#7C3AED" : "#e8e4f5"}`, borderRadius: 14, padding: "14px 12px", cursor: "pointer", background: selectedPlan === p.id ? "#f5f0fe" : "#fff", position: "relative", transition: "all 0.15s" }}>
                {p.savings && <div style={{ position: "absolute", top: -10, right: 10, background: "#7C3AED", color: "#fff", fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 20 }}>SAVE {p.savings}</div>}
                <div style={{ fontFamily: "'Fraunces',serif", fontWeight: 700, fontSize: 15, marginBottom: 2 }}>{p.label}</div>
                <div style={{ fontSize: 20, fontWeight: 700, color: selectedPlan === p.id ? "#7C3AED" : "#1a1a1a" }}>${p.price}<span style={{ fontSize: 12, fontWeight: 400, color: "#888" }}>/{p.period}</span></div>
                <div style={{ fontSize: 11, color: "#aaa", marginTop: 3 }}>${p.perMonth}/mo</div>
              </div>
            ))}
          </div>

          {/* Features */}
          <div style={{ display: "flex", flexDirection: "column", gap: 9, marginBottom: 22 }}>
            {[["🔥","Calorie & macro breakdown on every recipe"],["🎯","Personalised goals: build muscle or lose fat"],["🧬","AI suggestions tailored to your body stats"],["📊","Weekly calorie tracker & meal log"],["🥗","10 meal suggestions (vs 6 on free)"]].map(([i, t]) => (
              <div key={t} style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 14 }}>
                <span style={{ fontSize: 18, width: 34, height: 34, background: "#f5f0fe", borderRadius: 9, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{i}</span>
                {t}
              </div>
            ))}
          </div>

          <button className="btn-primary" onClick={() => setModal("payment")}>Continue to Payment →</button>
          <div style={{ fontSize: 12, color: "#bbb", textAlign: "center", marginTop: 10 }}>
            Free for 24 hrs, then ${plan.price}/{plan.period} · Cancel anytime
          </div>
        </div>
      </div>
    );
  }

  function PaymentSheet() {
    const [payMethod, setPayMethod] = useState("card"); // "card" | "apple" | "paypal"
    const [card, setCard]           = useState({ name: "", number: "", expiry: "", cvv: "" });
    const [processing, setProcessing] = useState(false);
    const [stripeError, setStripeError] = useState("");
    const [errors, setErrors]       = useState({});
    const stripeRef   = useRef(null);
    const elementsRef = useRef(null);
    const plan        = PLANS[selectedPlan] || PLANS.weekly;

    // Load Stripe.js and mount card element
    useEffect(() => {
      if (payMethod !== "card") return;
      const existing = document.getElementById("stripe-js");
      function mountElements() {
        if (!window.Stripe || !STRIPE_KEY) return;
        try {
          stripeRef.current   = window.Stripe(STRIPE_KEY);
          elementsRef.current = stripeRef.current.elements();
          const el = document.getElementById("stripe-card-element");
          if (el && !el.hasChildNodes()) {
            const cardEl = elementsRef.current.create("card", {
              style: { base: { fontFamily: "DM Sans, sans-serif", fontSize: "15px", color: "#1a1a1a", "::placeholder": { color: "#bbb" } } }
            });
            cardEl.mount("#stripe-card-element");
            cardEl.on("change", e => setStripeError(e.error ? e.error.message : ""));
          }
        } catch(e) { console.warn("Stripe init failed:", e); }
      }
      if (!existing) {
        const s = document.createElement("script");
        s.id  = "stripe-js"; s.src = "https://js.stripe.com/v3/";
        s.onload = mountElements;
        document.head.appendChild(s);
      } else if (window.Stripe) {
        setTimeout(mountElements, 100);
      }
    }, [payMethod]);

    async function submitCard() {
      if (!card.name.trim()) { setErrors({ name: true }); return; }
      setProcessing(true); setStripeError("");
      try {
        if (stripeRef.current && elementsRef.current) {
          // Real Stripe flow: create PaymentMethod → send to your backend → create Subscription
          const cardEl = elementsRef.current.getElement("card");
          const { paymentMethod, error } = await stripeRef.current.createPaymentMethod({
            type: "card", card: cardEl, billing_details: { name: card.name }
          });
          if (error) { setStripeError(error.message); setProcessing(false); return; }
          // ── TODO: send paymentMethod.id + plan.priceId to your backend ──
          // await fetch("/api/create-subscription", { method:"POST", body: JSON.stringify({ paymentMethodId: paymentMethod.id, priceId: plan.priceId }) });
          // For now, record last4 from Stripe response:
          const last4 = paymentMethod.card?.last4 || "****";
          startTrial(last4, selectedPlan);
        } else {
          // Stripe.js not loaded — fallback to validated mock (for local dev without key)
          const e = {};
          if (!card.name.trim()) e.name = true;
          if (card.number.replace(/\s/g,"").length < 16) e.number = true;
          if (card.expiry.length < 5) e.expiry = true;
          if (card.cvv.length < 3) e.cvv = true;
          setErrors(e);
          if (Object.keys(e).length) { setProcessing(false); return; }
          await new Promise(r => setTimeout(r, 1200));
          startTrial(card.number.replace(/\s/g,"").slice(-4), selectedPlan);
        }
      } catch(e) { setStripeError("Payment failed. Please try again."); setProcessing(false); }
    }

    async function submitPayPal() {
      setProcessing(true);
      // TODO: redirect to PayPal billing agreement URL from your backend
      await new Promise(r => setTimeout(r, 1500));
      startTrial("PayPal", selectedPlan);
    }

    async function submitApplePay() {
      setProcessing(true);
      if (!stripeRef.current && window.Stripe && STRIPE_KEY) {
        stripeRef.current = window.Stripe(STRIPE_KEY);
      }
      if (stripeRef.current) {
        const pr = stripeRef.current.paymentRequest({
          country: "US", currency: "usd",
          total: { label: `FridgeCook Pro (${plan.label})`, amount: Math.round(plan.price * 100) },
          requestPayerName: true, requestPayerEmail: true,
        });
        const canMake = await pr.canMakePayment();
        if (canMake?.applePay) {
          pr.on("paymentmethod", async (e) => {
            // TODO: confirm with backend, then e.complete("success")
            e.complete("success");
            startTrial(e.paymentMethod.card?.last4 || "AP", selectedPlan);
          });
          pr.show(); setProcessing(false); return;
        }
      }
      // Fallback if Apple Pay unavailable on this device
      setStripeError("Apple Pay is not available on this device. Please use card or PayPal.");
      setProcessing(false);
    }

    function fmt(field, val) {
      if (field === "number") val = val.replace(/\D/g,"").slice(0,16).replace(/(.{4})/g,"$1 ").trim();
      if (field === "expiry") val = val.replace(/\D/g,"").slice(0,4).replace(/^(\d{2})(\d)/,"$1/$2");
      if (field === "cvv")    val = val.replace(/\D/g,"").slice(0,4);
      setCard(c => ({ ...c, [field]: val }));
    }

    return (
      <div className="overlay" onClick={() => !processing && setModal(null)}>
        <div className="sheet" onClick={e => e.stopPropagation()}>
          <div className="handle" />
          <h2>Payment Method</h2>
          <div className="pay-summary">
            <strong>Free for 24 hours</strong>, then <strong>${plan.price}/{plan.period}</strong>.<br/>
            We'll notify you before charging. Cancel anytime.
          </div>

          {processing ? (
            <div style={{ textAlign:"center", padding:"36px 0" }}>
              <div className="spinner" style={{ margin:"0 auto 16px" }} />
              <p style={{ color:"#888", fontSize:14 }}>Processing securely…</p>
            </div>
          ) : (
            <>
              {/* Payment method tabs */}
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:8, marginBottom:20 }}>
                <button onClick={() => setPayMethod("card")}
                  style={{ padding:"12px 4px", border:`1.5px solid ${payMethod==="card"?"#7C3AED":"#e8e4f5"}`, borderRadius:10, background: payMethod==="card"?"#f5f0fe":"#fff", color: payMethod==="card"?"#7C3AED":"#555", fontSize:12, fontWeight: payMethod==="card"?600:400, cursor:"pointer", fontFamily:"DM Sans, sans-serif", transition:"all 0.15s", display:"flex", alignItems:"center", justifyContent:"center", gap:5 }}>
                  💳 Card
                </button>
                <button onClick={() => setPayMethod("apple")}
                  style={{ padding:"12px 4px", border:`1.5px solid ${payMethod==="apple"?"#7C3AED":"#e8e4f5"}`, borderRadius:10, background: payMethod==="apple"?"#000":"#fff", cursor:"pointer", transition:"all 0.15s", display:"flex", alignItems:"center", justifyContent:"center", gap:5 }}>
                  <span style={{ fontSize:14 }}></span>
                  <span style={{ fontSize:12, fontWeight:600, color: payMethod==="apple"?"#fff":"#333" }}>Apple Pay</span>
                </button>
                <button onClick={() => setPayMethod("paypal")}
                  style={{ padding:"12px 4px", border:`1.5px solid ${payMethod==="paypal"?"#7C3AED":"#e8e4f5"}`, borderRadius:10, background: payMethod==="paypal"?"#f5f0fe":"#fff", cursor:"pointer", transition:"all 0.15s", display:"flex", alignItems:"center", justifyContent:"center" }}>
                  <img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 124 33'%3E%3Cpath d='M46.2 6.8h-8.6c-.6 0-1.1.4-1.2 1l-3.5 22c-.1.5.3.9.8.9h4.1c.6 0 1.1-.4 1.2-1l.9-5.9c.1-.6.6-1 1.2-1h2.7c5.6 0 8.9-2.7 9.7-8.1.4-2.4 0-4.2-1.1-5.5-1.2-1.5-3.3-2.4-6.2-2.4zm1 8c-.5 3-2.8 3-5.1 3h-1.3l.9-5.7c0-.4.4-.6.7-.6h.6c1.5 0 3 0 3.7.9.5.5.6 1.3.5 2.4zM73.6 14.7h-4.1c-.3 0-.7.2-.7.6l-.2 1.1-.3-.4c-.9-1.3-2.8-1.7-4.8-1.7-4.5 0-8.3 3.4-9 8.2-.4 2.4.2 4.6 1.5 6.2 1.2 1.4 3 2 5 2 3.6 0 5.6-2.3 5.6-2.3l-.2 1.1c-.1.5.3.9.8.9h3.7c.6 0 1.1-.4 1.2-1l2.2-14.2c.2-.5-.2-.9-.7-.5zm-5.8 7.9c-.4 2.3-2.2 3.9-4.6 3.9-1.2 0-2.1-.4-2.7-1.1-.6-.7-.8-1.7-.6-2.8.4-2.3 2.2-3.9 4.5-3.9 1.1 0 2.1.4 2.7 1.1.6.8.9 1.8.7 2.8zM96.3 14.7h-4.2c-.4 0-.7.2-.9.5l-5.5 8.2-2.4-7.9c-.1-.5-.6-.8-1.1-.8h-4.1c-.5 0-.9.5-.7 1l4.4 13-4.2 5.9c-.4.5 0 1.2.6 1.2h4.1c.4 0 .7-.2.9-.5l13.4-19.4c.5-.4.1-1.2-.3-1.2z' fill='%23253B80'/%3E%3Cpath d='M110.4 6.8h-8.6c-.6 0-1.1.4-1.2 1l-3.5 22c-.1.5.3.9.8.9h4.4c.4 0 .8-.3.9-.7l1-6.2c.1-.6.6-1 1.2-1h2.7c5.6 0 8.9-2.7 9.7-8.1.4-2.4 0-4.2-1.1-5.5-1.3-1.5-3.4-2.4-6.3-2.4zm1 8c-.5 3-2.8 3-5.1 3h-1.3l.9-5.7c0-.4.4-.6.7-.6h.6c1.5 0 3 0 3.7.9.5.5.7 1.3.5 2.4zM137.6 14.7h-4.1c-.3 0-.7.2-.7.6l-.2 1.1-.3-.4c-.9-1.3-2.8-1.7-4.8-1.7-4.5 0-8.3 3.4-9 8.2-.4 2.4.2 4.6 1.5 6.2 1.2 1.4 3 2 5 2 3.6 0 5.6-2.3 5.6-2.3l-.2 1.1c-.1.5.3.9.8.9h3.7c.6 0 1.1-.4 1.2-1l2.2-14.2c.2-.5-.2-.9-.7-.5zm-5.7 7.9c-.4 2.3-2.2 3.9-4.6 3.9-1.2 0-2.1-.4-2.7-1.1-.6-.7-.8-1.7-.6-2.8.4-2.3 2.2-3.9 4.5-3.9 1.1 0 2.1.4 2.7 1.1.6.8.8 1.8.7 2.8zM143.3 7.4l-3.5 22.4c-.1.5.3.9.8.9h3.6c.6 0 1.1-.4 1.2-1l3.5-22c.1-.5-.3-.9-.8-.9h-4c-.4 0-.7.2-.8.6z' fill='%23179BD7'/%3E%3C/svg%3E" style={{ height:16 }} />
                </button>
              </div>

              {payMethod === "card" && (
                <>
                  <div className="pay-form">
                    <div className="pay-field">
                      <label>Cardholder Name</label>
                      <input placeholder="Jane Smith" value={card.name} onChange={e => { setErrors({}); fmt("name", e.target.value); }} style={{ borderColor: errors.name?"#e55":"" }} />
                    </div>
                    {STRIPE_KEY ? (
                      <div className="pay-field">
                        <label>Card Details</label>
                        <div id="stripe-card-element" style={{ padding:"13px 14px", border:`1.5px solid ${stripeError?"#e55":"#e8e4f5"}`, borderRadius:10, background:"#fff", minHeight:46 }} />
                        {stripeError && <div style={{ color:"#e55", fontSize:12, marginTop:4 }}>{stripeError}</div>}
                      </div>
                    ) : (
                      <>
                        <div className="pay-field">
                          <label>Card Number</label>
                          <input placeholder="1234 5678 9012 3456" value={card.number} onChange={e => fmt("number", e.target.value)} inputMode="numeric" style={{ borderColor: errors.number?"#e55":"" }} />
                        </div>
                        <div className="pay-row">
                          <div className="pay-field"><label>Expiry</label><input placeholder="MM/YY" value={card.expiry} onChange={e => fmt("expiry", e.target.value)} inputMode="numeric" style={{ borderColor: errors.expiry?"#e55":"" }} /></div>
                          <div className="pay-field"><label>CVV</label><input placeholder="123" value={card.cvv} onChange={e => fmt("cvv", e.target.value)} inputMode="numeric" style={{ borderColor: errors.cvv?"#e55":"" }} /></div>
                        </div>
                      </>
                    )}
                  </div>
                  <div className="pay-security">🔒 Secured by Stripe</div>
                  <button className="btn-primary" onClick={submitCard}>Start Free Trial</button>
                </>
              )}

              {payMethod === "apple" && (
                <div style={{ textAlign:"center", padding:"12px 0 8px" }}>
                  <div style={{ fontSize:40, textAlign:'center', margin:'16px 0' }}></div>
                  <p style={{ fontSize:14, color:'#555', marginBottom:20, lineHeight:1.6 }}>Pay with Face ID or Touch ID. No card details needed.</p>
                  <button onClick={submitApplePay} style={{ background:"#000", color:"#fff", border:"none", width:"100%", padding:"14px", borderRadius:12, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", gap:10, fontSize:15, fontWeight:600, fontFamily:"DM Sans, sans-serif" }}>
                    <img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 814 1000'%3E%3Cpath d='M788.1 340.9c-5.8 4.5-108.2 62.2-108.2 190.5 0 148.4 130.3 200.9 134.2 202.2-.6 3.2-20.7 71.9-68.7 141.9-42.8 61.6-87.5 123.1-155.5 123.1s-85.5-39.5-164-39.5c-76 0-103.7 40.8-165.9 40.8s-105-37.5-167.2-140.7C108.2 633.6 7 381.9 7 167.1 7-66 148.2-51.8 280.4 51.2c98.7 0 162.3 57.4 220.3 57.4 55.6 0 127.4-61 236.3-61 38.2 0 154.8 3.2 238.2 126.8zm-71.7-172c-41.9 52.3-101.9 92.3-161.9 87.3-7.4-59.5 21.9-122.8 57.2-161.8 41.9-49.3 108.2-87.3 163.7-89.3 6.4 61.5-17.7 122.8-59 163.8z' fill='currentColor'/%3E%3C/svg%3E" style={{ width:18, height:18, filter:"invert(1)" }} />
                    Pay with Apple Pay
                  </button>
                  <p style={{ fontSize:11, color:"#aaa", marginTop:10 }}>Requires Safari on an Apple device</p>
                </div>
              )}

              {payMethod === "paypal" && (
                <div style={{ textAlign:"center", padding:"12px 0 8px" }}>
                  <div style={{ display:'flex', alignItems:'center', justifyContent:'center', margin:'16px 0' }}><img src='data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 124 33'%3E%3Cpath d='M46.2 6.8h-8.6c-.6 0-1.1.4-1.2 1l-3.5 22c-.1.5.3.9.8.9h4.1c.6 0 1.1-.4 1.2-1l.9-5.9c.1-.6.6-1 1.2-1h2.7c5.6 0 8.9-2.7 9.7-8.1.4-2.4 0-4.2-1.1-5.5-1.2-1.5-3.3-2.4-6.2-2.4zm1 8c-.5 3-2.8 3-5.1 3h-1.3l.9-5.7c0-.4.4-.6.7-.6h.6c1.5 0 3 0 3.7.9.5.5.6 1.3.5 2.4zM73.6 14.7h-4.1c-.3 0-.7.2-.7.6l-.2 1.1-.3-.4c-.9-1.3-2.8-1.7-4.8-1.7-4.5 0-8.3 3.4-9 8.2-.4 2.4.2 4.6 1.5 6.2 1.2 1.4 3 2 5 2 3.6 0 5.6-2.3 5.6-2.3l-.2 1.1c-.1.5.3.9.8.9h3.7c.6 0 1.1-.4 1.2-1l2.2-14.2c.2-.5-.2-.9-.7-.5zm-5.8 7.9c-.4 2.3-2.2 3.9-4.6 3.9-1.2 0-2.1-.4-2.7-1.1-.6-.7-.8-1.7-.6-2.8.4-2.3 2.2-3.9 4.5-3.9 1.1 0 2.1.4 2.7 1.1.6.8.9 1.8.7 2.8zM96.3 14.7h-4.2c-.4 0-.7.2-.9.5l-5.5 8.2-2.4-7.9c-.1-.5-.6-.8-1.1-.8h-4.1c-.5 0-.9.5-.7 1l4.4 13-4.2 5.9c-.4.5 0 1.2.6 1.2h4.1c.4 0 .7-.2.9-.5l13.4-19.4c.5-.4.1-1.2-.3-1.2z' fill='%23253B80'/%3E%3Cpath d='M110.4 6.8h-8.6c-.6 0-1.1.4-1.2 1l-3.5 22c-.1.5.3.9.8.9h4.4c.4 0 .8-.3.9-.7l1-6.2c.1-.6.6-1 1.2-1h2.7c5.6 0 8.9-2.7 9.7-8.1.4-2.4 0-4.2-1.1-5.5-1.3-1.5-3.4-2.4-6.3-2.4zm1 8c-.5 3-2.8 3-5.1 3h-1.3l.9-5.7c0-.4.4-.6.7-.6h.6c1.5 0 3 0 3.7.9.5.5.7 1.3.5 2.4zM137.6 14.7h-4.1c-.3 0-.7.2-.7.6l-.2 1.1-.3-.4c-.9-1.3-2.8-1.7-4.8-1.7-4.5 0-8.3 3.4-9 8.2-.4 2.4.2 4.6 1.5 6.2 1.2 1.4 3 2 5 2 3.6 0 5.6-2.3 5.6-2.3l-.2 1.1c-.1.5.3.9.8.9h3.7c.6 0 1.1-.4 1.2-1l2.2-14.2c.2-.5-.2-.9-.7-.5zm-5.7 7.9c-.4 2.3-2.2 3.9-4.6 3.9-1.2 0-2.1-.4-2.7-1.1-.6-.7-.8-1.7-.6-2.8.4-2.3 2.2-3.9 4.5-3.9 1.1 0 2.1.4 2.7 1.1.6.8.8 1.8.7 2.8zM143.3 7.4l-3.5 22.4c-.1.5.3.9.8.9h3.6c.6 0 1.1-.4 1.2-1l3.5-22c.1-.5-.3-.9-.8-.9h-4c-.4 0-.7.2-.8.6z' fill='%23179BD7'/%3E%3C/svg%3E' style={{ height:28 }} /></div>
                  <p style={{ fontSize:14, color:'#555', marginBottom:20, lineHeight:1.6 }}>You'll be redirected to PayPal to complete your subscription.</p>
                  <button onClick={submitPayPal} style={{ background:"#FFC439", color:"#003087", border:"none", width:"100%", padding:"14px", borderRadius:12, cursor:"pointer", fontWeight:700, fontSize:15, display:"flex", alignItems:"center", justifyContent:"center", gap:8, fontFamily:"DM Sans, sans-serif" }}>
                    <svg width="80" height="20" viewBox="0 0 80 22" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M9.26 1.5H3.8C3.4 1.5 3.06 1.78 3 2.18L.76 16.4c-.05.3.18.57.49.57h2.67c.4 0 .74-.28.8-.68l.6-3.8c.06-.4.4-.68.8-.68h1.74c3.62 0 5.71-1.75 6.26-5.22.24-1.52.01-2.71-.68-3.54C12.67 2 11.2 1.5 9.26 1.5zm.63 5.14c-.3 1.97-1.8 1.97-3.26 1.97h-.83l.58-3.67c.03-.22.23-.38.45-.38h.38c.99 0 1.93 0 2.41.56.29.34.38.84.27 1.52zM24.1 6.58h-2.68c-.22 0-.41.16-.45.38l-.11.73-.18-.26c-.57-.82-1.83-1.1-3.09-1.1-2.89 0-5.36 2.19-5.84 5.26-.25 1.53.1 2.99.96 4.01.79.93 1.91 1.32 3.25 1.32 2.33 0 3.62-1.5 3.62-1.5l-.12.72c-.05.3.18.57.49.57h2.41c.4 0 .74-.28.8-.68l1.45-9.17c.04-.3-.2-.58-.51-.28zm-3.73 5.09c-.25 1.49-1.44 2.49-2.95 2.49-.76 0-1.36-.24-1.75-.7-.39-.46-.53-1.11-.41-1.84.23-1.48 1.44-2.51 2.93-2.51.74 0 1.34.25 1.74.71.4.47.56 1.13.44 1.85zM37.8 6.58h-2.69c-.25 0-.48.12-.62.33l-3.58 5.27-1.52-5.07c-.1-.32-.39-.53-.72-.53h-2.64c-.34 0-.58.34-.47.66l2.86 8.4-2.69 3.8c-.23.33 0 .78.4.78h2.68c.24 0 .47-.12.61-.32l8.64-12.48c.23-.33 0-.84-.26-.84z" fill="#253B80"/><path d="M45.5 1.5h-5.46c-.4 0-.74.28-.8.68L37 16.4c-.05.3.18.57.49.57h2.86c.28 0 .52-.2.56-.48l.63-4c.06-.4.4-.68.8-.68h1.74c3.62 0 5.71-1.75 6.26-5.22.24-1.52.01-2.71-.68-3.54C48.9 2 47.44 1.5 45.5 1.5zm.63 5.14c-.3 1.97-1.8 1.97-3.26 1.97h-.82l.58-3.67c.03-.22.23-.38.45-.38h.38c.99 0 1.93 0 2.41.56.29.34.37.84.26 1.52zM60.34 6.58h-2.67c-.22 0-.42.16-.45.38l-.12.73-.18-.26c-.57-.82-1.83-1.1-3.09-1.1-2.89 0-5.36 2.19-5.84 5.26-.25 1.53.1 2.99.96 4.01.79.93 1.92 1.32 3.25 1.32 2.33 0 3.62-1.5 3.62-1.5l-.12.72c-.05.3.18.57.49.57h2.41c.4 0 .74-.28.8-.68l1.44-9.17c.05-.3-.19-.58-.5-.28zm-3.72 5.09c-.25 1.49-1.44 2.49-2.95 2.49-.76 0-1.36-.24-1.75-.7-.39-.46-.54-1.11-.41-1.84.23-1.48 1.44-2.51 2.92-2.51.74 0 1.35.25 1.74.71.41.47.57 1.13.45 1.85zM63.07 1.84l-2.29 14.57c-.05.3.18.57.49.57h2.31c.4 0 .74-.28.8-.68L66.65 2.1c.05-.3-.18-.57-.49-.57h-2.6c-.23 0-.42.14-.49.31z" fill="#179BD7"/></svg>
                  </button>
                </div>
              )}

              {stripeError && payMethod !== "card" && <div style={{ color:"#e55", fontSize:13, textAlign:"center", marginTop:12 }}>{stripeError}</div>}
              <div style={{ fontSize:12, color:"#bbb", textAlign:"center", marginTop:12 }}>You won't be charged for 24 hours</div>
            </>
          )}
        </div>
      </div>
    );
  }

  function ProfileSheet() {
    const [form, setForm] = useState({ ...profile });
    const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
    const preview = form.weight && form.height && form.age ? calcTDEE(form) : null;
    return (
      <div className="overlay" onClick={() => setModal(null)}>
        <div className="sheet" onClick={e => e.stopPropagation()}>
          <div className="handle" />
          <h2>Your Body Profile 🧬</h2>
          <p>We'll calculate your ideal daily calories and personalise every meal suggestion.</p>
          <div className="profile-grid">
            <div className="field"><label>Weight (kg)</label><input type="number" placeholder="70" value={form.weight} onChange={e => set("weight", e.target.value)} /></div>
            <div className="field"><label>Height (cm)</label><input type="number" placeholder="175" value={form.height} onChange={e => set("height", e.target.value)} /></div>
            <div className="field"><label>Age</label><input type="number" placeholder="28" value={form.age} onChange={e => set("age", e.target.value)} /></div>
            <div className="field"><label>Sex</label><select value={form.sex} onChange={e => set("sex", e.target.value)}><option value="male">Male</option><option value="female">Female</option></select></div>
            <div className="field full"><label>Activity Level</label>
              <select value={form.activityLevel} onChange={e => set("activityLevel", e.target.value)}>
                <option value="sedentary">Sedentary — little/no exercise</option>
                <option value="light">Light — 1–3 days/week</option>
                <option value="moderate">Moderate — 3–5 days/week</option>
                <option value="active">Very Active — 6–7 days/week</option>
              </select>
            </div>
          </div>
          <div className="field"><label>My Goal</label>
            <div className="goal-opts">
              {[{ k:"fat",i:"🔥",l:"Lose Fat"},{k:"maintain",i:"⚖️",l:"Maintain"},{k:"muscle",i:"💪",l:"Build Muscle"}].map(g => (
                <div key={g.k} className={`goal-opt ${form.goal===g.k?"sel":""}`} onClick={() => set("goal", g.k)}>
                  <span className="gi">{g.i}</span>{g.l}
                </div>
              ))}
            </div>
          </div>
          {preview && <div className="tdee-hint">🎯 Recommended daily intake: <strong>{preview} kcal</strong>{form.goal==="muscle"&&<span style={{color:"#9d79f0"}}> (+300 surplus)</span>}{form.goal==="fat"&&<span style={{color:"#9d79f0"}}> (−500 deficit)</span>}</div>}
          <button className="save-btn" onClick={() => { setProfile({ ...form, profileDone: true }); setModal(null); }}>Save Profile</button>
        </div>
      </div>
    );
  }

  function ManageSheet() {
    const [confirmCancel, setConfirmCancel] = useState(false);
    const stored = readSub();
    const isTrial = sub.status === "trial";
    const isPaid  = sub.status === "paid";
    const cancelMsg = isTrial
      ? "Your free trial will end immediately and remaining time will be forfeited."
      : `You'll keep Pro access until ${new Date(stored.paidEnd).toLocaleDateString()}. You won't be charged again.`;

    function doCancel() {
      cancelSub();
      setModal(null);
      setNotification({ type: "cancelled", msg: isTrial ? "Trial cancelled. Pro access has ended." : `Pro access continues until ${new Date(stored.paidEnd).toLocaleDateString()}.` });
      setModal("notify");
    }

    return (
      <div className="overlay" onClick={() => setModal(null)}>
        <div className="sheet" onClick={e => e.stopPropagation()}>
          <div className="handle" />
          <h2>Manage Subscription</h2>
          <div style={{ display: "flex", flexDirection: "column", gap: 0, marginBottom: 24, background: "#f9f8ff", borderRadius: 14, overflow: "hidden", border: "1px solid #e8e4f5" }}>
            <div className="sub-info-row" style={{ padding: "12px 16px" }}><span className="sub-info-label">Plan</span><span className="sub-info-val">{isTrial ? "Free Trial" : "Pro Monthly"}</span></div>
            <div className="sub-info-row" style={{ padding: "12px 16px" }}><span className="sub-info-label">Status</span><span className="sub-info-val" style={{ color: "#7C3AED" }}>{sub.cancelled ? "Cancels at period end" : "Active"}</span></div>
            {isTrial && <div className="sub-info-row" style={{ padding: "12px 16px" }}><span className="sub-info-label">Trial ends</span><span className="sub-info-val">{sub.hoursLeft}h remaining</span></div>}
            {isPaid && <div className="sub-info-row" style={{ padding: "12px 16px" }}><span className="sub-info-label">{sub.cancelled ? "Access until" : "Next charge"}</span><span className="sub-info-val">{new Date(stored.paidEnd).toLocaleDateString()}</span></div>}
            <div className="sub-info-row" style={{ padding: "12px 16px" }}><span className="sub-info-label">Card</span><span className="sub-info-val">•••• {stored.cardLast4}</span></div>
            {!isTrial && <div className="sub-info-row" style={{ padding: "12px 16px" }}><span className="sub-info-label">Amount</span><span className="sub-info-val">{stored.planId === 'yearly' ? '$20.93/year' : '$2.99/week'}</span></div>}
          </div>

          {!sub.cancelled && (
            confirmCancel ? (
              <>
                <div className="cancel-box">⚠️ {cancelMsg}</div>
                <button className="btn-danger" onClick={doCancel} style={{ marginBottom: 10 }}>Yes, Cancel Subscription</button>
                <button className="btn-ghost" onClick={() => setConfirmCancel(false)}>Keep My Plan</button>
              </>
            ) : (
              <button className="btn-danger" onClick={() => setConfirmCancel(true)}>Cancel Subscription</button>
            )
          )}
          {sub.cancelled && (
            <div style={{ textAlign: "center", fontSize: 13, color: "#aaa", padding: "12px 0" }}>
              Your subscription is already cancelled.
            </div>
          )}
        </div>
      </div>
    );
  }

  function NotifySheet() {
    const icons = { trialEnd: "⏰", charge: "💳", cancelled: "✅", logged: "🍽️" };
    const titles = { trialEnd: "Trial Ended", charge: "Payment Processed", cancelled: "Subscription Cancelled", logged: "Meal Logged!" };
    const t = notification?.type || "logged";
    return (
      <div className="overlay" onClick={() => { setModal(null); setNotification(null); }}>
        <div className="notify-sheet" onClick={e => e.stopPropagation()}>
          <div className="handle" />
          <span className="notify-icon">{icons[t]}</span>
          <h3>{titles[t]}</h3>
          <p>{notification?.msg}</p>
          {t === "trialEnd" && <button className="btn-primary" onClick={() => { setModal("upgrade"); }} style={{ marginBottom: 10 }}>Upgrade to Pro</button>}
          <button className="btn-ghost" style={{ width: "100%" }} onClick={() => { setModal(null); setNotification(null); }}>Got it</button>
        </div>
      </div>
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // NAV BAR
  // ─────────────────────────────────────────────────────────────────────────

  function NavBar({ showBack, onBack }) {
    return (
      <nav className="nav">
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {showBack && <button className="back-btn" onClick={onBack}>←</button>}
          <span className="nav-logo">Fridge<span>Cook</span></span>
        </div>
        <div className="nav-right">
          {proActive && profile.profileDone && (
            <button className="icon-btn" title="Edit profile" onClick={() => setModal("profile")}>🧬</button>
          )}
          {sub.status === "trial" && !sub.cancelled && (
            <span className="status-pill pill-trial" onClick={() => setModal("manage")} style={{ cursor: "pointer" }}>⏱ {sub.hoursLeft}h left</span>
          )}
          {sub.status === "paid" && !sub.cancelled && (
            <span className="status-pill pill-paid">✦ Pro</span>
          )}
          {sub.status === "paid" && sub.cancelled && (
            <span className="status-pill pill-trial">Pro · ends {daysLeftPaid(sub)}d</span>
          )}
          {(!proActive && sub.status !== "trial") && (
            <span className="status-pill pill-none" onClick={() => setModal("upgrade")}>Try Pro</span>
          )}
        </div>
      </nav>
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // DOCK
  // ─────────────────────────────────────────────────────────────────────────

  function Dock() {
    const items = [
      { id: "home",  icon: "🏠", label: "Kitchen" },
      { id: "meals", icon: "🥘", label: "My Meals" },
      { id: "pro",   icon: "✦",  label: "FridgePro" },
    ];
    function handleTab(id) {
      setTab(id);
      if (id === "home") setScreen("home");
      if (id === "meals" && screen !== "suggestions" && screen !== "recipe") setScreen("suggestions");
    }
    return (
      <div className="dock">
        {items.map(it => (
          <button key={it.id} className={`dock-item ${tab === it.id ? "active" : ""}`} onClick={() => handleTab(it.id)}>
            <span className="dock-icon" style={{ opacity: tab === it.id ? 1 : 0.4 }}>{it.icon}</span>
            <span className="dock-label">{it.label}</span>
            {tab === it.id && <span className="dock-pip" />}
          </button>
        ))}
      </div>
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // SCREEN RENDERS
  // ─────────────────────────────────────────────────────────────────────────

  function HomeScreen() {
    return (
      <>
        <NavBar />
        <div className="home-hero">
          <h1>What can you cook <em>tonight?</em></h1>
          <p>Snap a photo of your fridge and get instant recipe ideas — no planning needed.</p>
        </div>
        <div className={`upload-zone ${dragOver ? "drag" : ""}`}
          onDragOver={e => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)} onDrop={onDrop}>
          <span className="upload-icon">📸</span>
          <h3>Photo your fridge</h3>
          <p>Drag & drop, use your camera, or pick a photo</p>
          <div className="upload-btn-row">
            <button className="upload-btn cam" onClick={() => cameraRef.current.click()}>📷 Take Photo</button>
            <button className="upload-btn" onClick={() => fileRef.current.click()}>🖼 Choose Photo</button>
          </div>
          <input ref={fileRef} type="file" accept="image/*" style={{ display: "none" }} onChange={onFileInput} />
          <input ref={cameraRef} type="file" accept="image/*" capture="environment" style={{ display: "none" }} onChange={onFileInput} />
        </div>

        {!proActive && (
          <div style={{ margin: "0 24px 32px", background: "linear-gradient(135deg,#1e1040,#3b1f7a)", borderRadius: 16, padding: 20, color: "#fff" }}>
            <div style={{ fontFamily: "'Fraunces',serif", fontSize: 16, marginBottom: 6 }}>✦ Try Pro Free for 24 Hours</div>
            <div style={{ fontSize: 13, color: "#b8a8e8", lineHeight: 1.5 }}>Calorie tracking, personalised goals, and diet-aware suggestions. No charge for 24 hours.</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
              {["24hr free trial","Build muscle / Lose fat","Calorie tracking","Weekly dashboard"].map(t => (
                <span key={t} style={{ fontSize: 11, padding: "4px 10px", background: "rgba(124,58,237,0.25)", border: "1px solid rgba(167,139,250,0.4)", borderRadius: 20, color: "#c4b5fd" }}>{t}</span>
              ))}
            </div>
            <div style={{ fontSize: 13, color: "#a78bfa", marginTop: 12, cursor: "pointer" }} onClick={() => setModal("upgrade")}>→ Start free trial — from $2.99/wk</div>
          </div>
        )}
      </>
    );
  }

  function MealsScreen() {
    if (suggestions.length === 0) return (
      <>
        <NavBar />
        <div className="empty-meals">
          <div className="big">🥘</div>
          <h3>No meals yet</h3>
          <p>Head to Kitchen, snap a photo of your fridge, and we'll generate meal ideas for you.</p>
          <button className="btn-primary" style={{ width: "auto", padding: "12px 28px", marginTop: 20 }} onClick={() => { setTab("home"); setScreen("home"); }}>
            Go to Kitchen →
          </button>
        </div>
      </>
    );

    if (screen === "recipe") return (
      <>
        <NavBar showBack onBack={() => setScreen("suggestions")} />
        {selectedMeal && (
          <div className="recipe-header">
            <span className="recipe-emoji">{selectedMeal.emoji || "🍽️"}</span>
            <div className="recipe-title">{selectedMeal.name}</div>
            <div className="chips">
              {recipe && <span className="chip">⏱ {recipe.totalTime}</span>}
              <span className="chip">{selectedMeal.difficulty}</span>
              {recipe && <span className="chip">🍽 {recipe.servings} servings</span>}
              {proActive && (recipe?.calories || selectedMeal?.calories) && (
                <span className="chip accent">🔥 {recipe?.calories || selectedMeal?.calories} kcal</span>
              )}
            </div>
          </div>
        )}
        {loading ? (
          <div className="loading-screen"><div className="spinner" /><p>Generating recipe…</p></div>
        ) : recipe ? (
          <>
            {proActive && recipe.macros && (
              <div className="macros-card">
                <h4>Macros per serving</h4>
                <div className="macros-row">
                  <div className="macro-item"><div className="macro-val">{recipe.macros.protein}g</div><div className="macro-lbl">Protein</div></div>
                  <div className="macro-item"><div className="macro-val">{recipe.macros.carbs}g</div><div className="macro-lbl">Carbs</div></div>
                  <div className="macro-item"><div className="macro-val">{recipe.macros.fat}g</div><div className="macro-lbl">Fat</div></div>
                </div>
              </div>
            )}
            <div className="recipe-body">
              <h3>Ingredients</h3>
              <ul className="ingredient-list">{recipe.ingredients?.map((ing, i) => <li key={i}>{ing}</li>)}</ul>
              <h3>Instructions</h3>
              <ol className="step-list">
                {recipe.steps?.map((step, i) => (
                  <li className="step-item" key={i}>
                    <span className="step-num">{i + 1}</span>
                    <span className="step-text">{step}</span>
                  </li>
                ))}
              </ol>
            </div>
            {proActive && <button className="log-btn" onClick={logMeal}>+ Log this meal</button>}
          </>
        ) : null}
      </>
    );

    return (
      <>
        <NavBar />
        <div className="section-header">
          <h2>Here's what you can make</h2>
          <p>{suggestions.length} meal ideas from your fridge</p>
        </div>
        {proActive && profile.profileDone && (
          <div className="goal-banner">
            {profile.goal === "muscle" ? "💪" : profile.goal === "fat" ? "🔥" : "⚖️"}
            <span>Tailored for your <strong>{profile.goal === "muscle" ? "muscle gain" : profile.goal === "fat" ? "fat loss" : "maintenance"}</strong> goal</span>
          </div>
        )}
        {imagePreview && <div className="fridge-thumb"><img src={imagePreview} alt="fridge" /></div>}
        <div className="meal-grid">
          {suggestions.map((meal, i) => (
            <div className="meal-card" key={i} onClick={() => { fetchRecipe(meal); setScreen("recipe"); }}>
              <span className="meal-emoji">{meal.emoji || "🍽️"}</span>
              <div className="meal-name">{meal.name}</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                <span className="meal-tag">⏱ {meal.time}</span>
                <span className="meal-tag">📊 {meal.difficulty}</span>
              </div>
              {proActive && meal.calories && <div className="meal-calories">{meal.calories} kcal</div>}
            </div>
          ))}
        </div>
      </>
    );
  }

  function ProScreen() {
    const chartData = getDashboardData();
    const pct = Math.min(100, Math.round((todayCalories / calorieGoal) * 100));
    const stored = readSub();

    return (
      <>
        <NavBar />
        <div className="pro-page">
          <h2>FridgePro ✦</h2>
          <div className="sub">Manage your plan, goals & calorie stats</div>

          {/* Active plan card */}
          {proActive ? (
            <div className="plan-card active">
              <span className="plan-badge pro">✦ Pro {sub.status === "trial" ? "— Trial" : "— Active"}</span>
              <div className="plan-name">FridgeCook Pro</div>
              <div className="plan-price">${stored.planId === "yearly" ? "89.99" : "2.99"} <span>/{stored.planId === "yearly" ? "yr" : "wk"}</span></div>
              {sub.status === "trial" && <div className="plan-desc">⏱ {sub.hoursLeft} hours left in your free trial</div>}
              {sub.status === "paid" && sub.cancelled && <div className="plan-desc">Access until {new Date(stored.paidEnd).toLocaleDateString()}</div>}
              {sub.status === "paid" && !sub.cancelled && <div className="plan-desc">Next charge: {new Date(stored.paidEnd).toLocaleDateString()} · Card •••• {stored.cardLast4}</div>}
              <div className="plan-actions">
                {!sub.cancelled && <button className="btn-primary white" onClick={() => setModal("manage")}>Manage Subscription</button>}
                <button className="btn-primary white" onClick={() => setModal("profile")}>Edit Body Profile 🧬</button>
              </div>
            </div>
          ) : (
            <div className="plan-card inactive">
              <span className="plan-badge free">Free Plan</span>
              <div className="plan-name">FridgeCook Free</div>
              <div className="plan-features" style={{ marginBottom: 16 }}>
                {[["✓","6 meal suggestions per scan"],["✓","Full recipes"],["✗","Calorie & macro info"],["✗","Personalised goals"],["✗","Meal logging & dashboard"]].map(([c, t]) => (
                  <div className="plan-feat" key={t}><span className={`ck ${c==="✗"?"gray":""}`}>{c}</span>{t}</div>
                ))}
              </div>
              {/* Plan picker */}
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginBottom:14 }}>
                {Object.values(PLANS).map(p => (
                  <div key={p.id} onClick={() => setSelectedPlan(p.id)}
                    style={{ border:`2px solid ${selectedPlan===p.id?"#7C3AED":"#e8e4f5"}`, borderRadius:12, padding:"12px 10px", cursor:"pointer", background: selectedPlan===p.id?"#f5f0fe":"#fafafa", position:"relative", transition:"all 0.15s" }}>
                    {p.savings && <div style={{ position:"absolute", top:-9, right:8, background:"#7C3AED", color:"#fff", fontSize:9, fontWeight:700, padding:"2px 7px", borderRadius:20 }}>SAVE {p.savings}</div>}
                    <div style={{ fontFamily:"'Fraunces',serif", fontWeight:700, fontSize:14 }}>{p.label}</div>
                    <div style={{ fontSize:18, fontWeight:700, color: selectedPlan===p.id?"#7C3AED":"#1a1a1a" }}>${p.price}<span style={{ fontSize:11, fontWeight:400, color:"#888" }}>/{p.period}</span></div>
                    <div style={{ fontSize:10, color:"#aaa" }}>${p.perMonth}/mo</div>
                  </div>
                ))}
              </div>
              <div className="plan-actions">
                <button className="btn-primary" onClick={() => setModal("payment")}>Start Free 24-Hour Trial</button>
              </div>
              <div className="card-hint">💳 Card · Apple Pay · PayPal · no charge for 24 hrs</div>
            </div>
          )}

          {/* Calorie dashboard (pro only) */}
          {proActive && (
            <>
              <div style={{ height: 24 }} />
              {profile.profileDone && (
                <div style={{ background: "#fff", border: "1.5px solid #e8e4f5", borderRadius: 16, padding: "14px 16px", display: "flex", justifyContent: "space-between", marginBottom: 20 }}>
                  <div>
                    <div style={{ fontSize: 11, color: "#aaa", marginBottom: 3, textTransform: "uppercase", letterSpacing: "0.5px" }}>Goal</div>
                    <div style={{ fontFamily: "'Fraunces',serif", fontWeight: 600, fontSize: 15 }}>
                      {profile.goal==="muscle"?"💪 Build Muscle":profile.goal==="fat"?"🔥 Lose Fat":"⚖️ Maintain"}
                    </div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div style={{ fontSize: 11, color: "#aaa", marginBottom: 3, textTransform: "uppercase", letterSpacing: "0.5px" }}>Daily Target</div>
                    <div style={{ fontFamily: "'Fraunces',serif", fontWeight: 700, fontSize: 20, color: "#7C3AED" }}>{calorieGoal} kcal</div>
                  </div>
                </div>
              )}
              <div className="dash-section" style={{ padding: "0 0 24px" }}>
                <h3>Today</h3>
                <div className="goal-card">
                  <div className="goal-val">{todayCalories} <span>/ {calorieGoal} kcal</span></div>
                  <div className="progress-bar"><div className="progress-fill" style={{ width: `${pct}%` }} /></div>
                  <div style={{ fontSize: 12, color: "#888", marginTop: 6 }}>{pct}% of daily goal</div>
                </div>
              </div>
              <div className="dash-section" style={{ padding: "0 0 24px" }}>
                <h3>This Week</h3>
                <div className="chart-wrap">
                  <ResponsiveContainer width="100%" height={180}>
                    <BarChart data={chartData} barSize={24}>
                      <XAxis dataKey="day" tick={{ fontSize: 12, fill: "#888" }} axisLine={false} tickLine={false} />
                      <YAxis hide />
                      <Tooltip formatter={v => [`${v} kcal`, "Calories"]} contentStyle={{ borderRadius: 8, border: "1px solid #e8e4f5", fontSize: 13 }} />
                      <Bar dataKey="calories" radius={[6, 6, 0, 0]}>
                        {chartData.map((e, i) => <Cell key={i} fill={e.calories > 0 ? "#7C3AED" : "#e8e4f5"} />)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
              <div className="dash-section" style={{ padding: "0 0 24px" }}>
                <h3>Meal Log</h3>
                {mealLog.length === 0 ? (
                  <div className="empty-state">No meals logged yet.<br />Cook something and tap "Log this meal"!</div>
                ) : (
                  <div className="log-list">
                    {[...mealLog].reverse().map((m, i) => (
                      <div className="log-item" key={i}>
                        <div><div className="log-item-name">{m.name}</div><div className="log-item-date">{m.date}</div></div>
                        <div className="log-item-cal">{m.calories} kcal</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </>
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ROOT RENDER
  // ─────────────────────────────────────────────────────────────────────────

  return (
    <div className="app">
      <style>{S}</style>

      <div className="app-body">
        {loading ? (
          <>
            <NavBar />
            <div className="loading-screen">
              <div className="spinner" />
              <p style={{ fontWeight: 600, fontSize: 16, color: "#1a1a1a", marginBottom: 4 }}>{loadingMsg}</p>
              {scanETA !== null && scanElapsed !== null && (
                <div style={{ textAlign: "center" }}>
                  <div style={{ fontSize: 13, color: "#888", marginBottom: 12 }}>
                    {`About ${scanETA}s remaining`}
                  </div>
                  <div style={{ width: 220, height: 6, background: "#e8e4f5", borderRadius: 3, overflow: "hidden", margin: "0 auto" }}>
                    <div style={{
                      height: "100%", borderRadius: 3, background: "#7C3AED",
                      width: `${Math.min(96, Math.max(4, Math.round((scanElapsed / (scanElapsed + scanETA)) * 100)))}%`,
                      transition: "width 1s linear"
                    }} />
                  </div>
                </div>
              )}
            </div>
          </>
        ) : (
          <>
            {tab === "home"  && <HomeScreen />}
            {tab === "meals" && <MealsScreen />}
            {tab === "pro"   && <ProScreen />}
          </>
        )}
      </div>

      <Dock />

      {/* Modals */}
      {modal === "upgrade" && <UpgradeSheet />}
      {modal === "payment" && <PaymentSheet />}
      {modal === "profile" && <ProfileSheet />}
      {modal === "manage"  && <ManageSheet />}
      {modal === "notify"  && <NotifySheet />}
    </div>
  );
}
