import { useState, useRef, useEffect, useCallback } from "react";

// ─── API KEY ─────────────────────────────────────────────────────────────────
function getApiKey() { return localStorage.getItem("op_apikey") || ""; }
function setApiKey(key) { localStorage.setItem("op_apikey", key); }


// ─── PERSISTENCE LAYER ───────────────────────────────────────────────────────
const DB = {
  get: (key, fallback = null) => {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
  },
  set: (key, val) => { try { localStorage.setItem(key, JSON.stringify(val)); } catch {} },
};

const INITIAL_PROFILE = {
  name: "Brayan",
  shipDate: "2025-09-01",
  goal: "Marine Corps → Alaska",
  xp: 0,
  streak: 0,
  lastActive: null,
  totalSessions: 0,
  weakSpots: {},       // category → { topic: missCount }
  masteredTopics: {},  // category → [topic]
  triviaHistory: [],   // { cat, q, correct, mode, ts }
  journalEntries: [],  // { id, cat, content, ts, tags }
  books: [],           // { title, author, status, notes, rating }
  missionLog: [],      // { date, missions: [{cat,task,done}] }
  aarLog: [],          // { ts, session_summary }
  scenario: null,      // live Alaska scenario state
  catXP: { survival: 0, history: 0, firearms: 0, wildlife: 0, plants: 0, books: 0 },
  sessions: {},        // category → [{ role, content }]
};

function loadProfile() {
  const saved = DB.get("op_profile");
  if (!saved) return { ...INITIAL_PROFILE };
  return { ...INITIAL_PROFILE, ...saved };
}

function saveProfile(p) { DB.set("op_profile", p); }

// ─── RANK SYSTEM ─────────────────────────────────────────────────────────────
const RANKS = [
  { name: "Recruit",       xp: 0,    badge: "◦" },
  { name: "Private",       xp: 100,  badge: "▪" },
  { name: "PFC",           xp: 300,  badge: "▸" },
  { name: "Lance Cpl",     xp: 600,  badge: "◈" },
  { name: "Corporal",      xp: 1000, badge: "◆" },
  { name: "Sergeant",      xp: 1800, badge: "★" },
  { name: "Staff Sgt",     xp: 3000, badge: "★★" },
  { name: "Operator",      xp: 5000, badge: "⬡" },
];
function getRank(xp) {
  let r = RANKS[0];
  for (const rank of RANKS) { if (xp >= rank.xp) r = rank; }
  return r;
}
function getNextRank(xp) {
  for (const rank of RANKS) { if (xp < rank.xp) return rank; }
  return null;
}

// ─── CATEGORIES ──────────────────────────────────────────────────────────────
const CATS = [
  { id: "survival",  label: "Survival",       icon: "🌲", color: "#5a9e6f", dim: "#1a2e1f" },
  { id: "history",   label: "US History",     icon: "🦅", color: "#c9a84c", dim: "#2a2010" },
  { id: "firearms",  label: "Firearms",       icon: "⚙️", color: "#9ba8c9", dim: "#1a1c2a" },
  { id: "wildlife",  label: "Wildlife",       icon: "🐻", color: "#c07a3a", dim: "#2a1a0e" },
  { id: "plants",    label: "Plants & Fungi", icon: "🍄", color: "#8ab84a", dim: "#1a2210" },
  { id: "books",     label: "Field Library",  icon: "📖", color: "#a07fc8", dim: "#1e1628" },
];

// ─── SYSTEM PROMPTS ───────────────────────────────────────────────────────────
function buildSystemPrompt(cat, profile, mode) {
  const rank = getRank(profile.xp);
  const daysOut = Math.max(0, Math.ceil((new Date(profile.shipDate) - new Date()) / 86400000));
  const weak = Object.entries(profile.weakSpots[cat] || {}).sort((a,b) => b[1]-a[1]).slice(0,3).map(e=>e[0]).join(", ") || "none identified yet";

  const ctx = `OPERATOR CONTEXT:
Name: ${profile.name} | Rank: ${rank.name} (${profile.xp} XP) | Days until ship-out: ${daysOut}
Goal: Marine Corps Infantry → MOS 1341 General Engineering → Alaska post-service (Homer/Kodiak)
Known weak spots in this category: ${weak}
Cat XP: ${profile.catXP[cat] || 0} | Mode: ${mode}
RULES: Never spoil trivia answers in the question phrasing. Keep responses tight and field-relevant. Always connect knowledge to his actual life — boot camp, Alaska, or the Corps.`;

  const bases = {
    survival: `You are a SERE instructor and wilderness survival expert. Brutal, precise, life-or-death accurate. Subarctic/Alaskan conditions are priority. Cover water, shelter, fire, signaling, navigation, improvised medicine, calorie management. In TRIVIA mode return ONLY this JSON: {"q":"...","a":["...","...","...","..."],"correct":0,"difficulty":"easy|medium|hard","topic":"..."} — difficulty matches his weak spots. In RECALL mode give one open question, no options. In SCENARIO mode continue the Alaska crash scenario based on his choice.`,
    history: `You are a US military and political historian. Connect history to the present — why it matters to a Marine, to a citizen, to someone who'll defend the country. Cover wars, policy, civil rights, economics, foreign relations. In TRIVIA mode return ONLY JSON: {"q":"...","a":["...","...","...","..."],"correct":0,"difficulty":"easy|medium|hard","topic":"..."}. In RECALL mode give one open question. In SCENARIO mode put him in a historical decision-making moment.`,
    firearms: `You are a Marine Corps weapons instructor and firearms historian. Cover US and foreign military weapons, pistols, rifles, LMGs, DMRs, shotguns, suppressors, calibers, mechanisms, care, and nomenclature. Always include phonetic pronunciation for names. The user is enlisting — prioritize what he'll actually train on: M4, M27, M9A1, M240, M249, M2. In TRIVIA mode return ONLY JSON: {"q":"...","a":["...","...","...","..."],"correct":0,"difficulty":"easy|medium|hard","topic":"..."}. In ID mode describe a weapon and ask him to name it.`,
    wildlife: `You are a wilderness safety biologist. North America first, Alaska priority. Cover bears (black, grizzly, polar), wolves, moose, venomous snakes, spiders, wasps, marine hazards. Explain: threat level, attack triggers, avoidance, response protocol, venom/injury treatment. Clinical and direct — wrong info gets people killed. In TRIVIA mode return ONLY JSON: {"q":"...","a":["...","...","...","..."],"correct":0,"difficulty":"easy|medium|hard","topic":"..."}`,
    plants: `You are a wilderness botanist and toxicologist. North American deadly plants, toxic berries, lethal mushrooms, and their edible lookalikes. Always cover: identification markers, toxin type, onset time, symptoms, treatment. Also teach safe edibles for foraging. In TRIVIA mode return ONLY JSON: {"q":"...","a":["...","...","...","..."],"correct":0,"difficulty":"easy|medium|hard","topic":"..."}. In ID mode describe a plant and ask if it's safe or deadly and why.`,
    books: `You are a reading coach for a future Marine and Alaskan outdoorsman. Recommend books across: survival, military history, philosophy, Alaskan wilderness, self-discipline, war memoirs, stoicism, and practical skills. Give title, author, one-line hook, and why it matters for his specific path. When he reports finishing a book, generate 3 deep reflection questions he should be able to answer. Track what he says he's reading and push him on it.`,
  };

  return `${ctx}\n\n${bases[cat]}`;
}

// ─── MISSION GENERATOR ────────────────────────────────────────────────────────
function generateMissions(profile) {
  const today = new Date().toDateString();
  const existing = profile.missionLog.find(m => m.date === today);
  if (existing) return existing.missions;

  const cats = [...CATS];
  const weak = Object.entries(profile.weakSpots)
    .flatMap(([cat, topics]) => Object.entries(topics).map(([t, c]) => ({ cat, topic: t, count: c })))
    .sort((a, b) => b.count - a.count);

  const missions = [];

  if (weak.length > 0) {
    missions.push({ cat: weak[0].cat, task: `Drill your weak spot: answer 3 trivia on "${weak[0].topic}"`, type: "trivia", done: false, xp: 30 });
  } else {
    missions.push({ cat: "survival", task: "Answer 3 survival trivia questions", type: "trivia", done: false, xp: 30 });
  }

  const lowCat = cats.sort((a, b) => (profile.catXP[a.id] || 0) - (profile.catXP[b.id] || 0))[0];
  missions.push({ cat: lowCat.id, task: `Study ${lowCat.label} — you haven't been here lately`, type: "study", done: false, xp: 20 });
  missions.push({ cat: "scenario", task: "Make one decision in your Alaska scenario", type: "scenario", done: false, xp: 40 });

  return missions;
}

// ─── TRIVIA COMPONENT ─────────────────────────────────────────────────────────
function TriviaCard({ data, onResult, profile, cat }) {
  const [selected, setSelected] = useState(null);
  const [revealed, setRevealed] = useState(false);
  const [explanation, setExplanation] = useState("");
  const [loadingExp, setLoadingExp] = useState(false);

  async function choose(idx) {
    if (revealed) return;
    setSelected(idx);
    setRevealed(true);
    const correct = idx === data.correct;
    onResult(correct, data.topic, data.difficulty);

    setLoadingExp(true);
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json",
          "x-api-key": getApiKey(),
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 300,
          system: buildSystemPrompt(cat, profile, "explanation"),
          messages: [{ role: "user", content: `The question was: "${data.q}" The correct answer is: "${data.a[data.correct]}". Give a 2-3 sentence field-relevant explanation of why. ${!correct ? `The user chose "${data.a[idx]}" — briefly address that misconception.` : ""}` }]
        })
      });
      const d = await res.json();
      setExplanation(d.content?.map(b => b.text || "").join("") || "");
    } catch {}
    setLoadingExp(false);
  }

  const catObj = CATS.find(c => c.id === cat);

  return (
    <div style={{ background: "#141414", border: `1px solid ${catObj.color}30`, borderRadius: 14, padding: 18, marginBottom: 12 }}>
      <div style={{ fontSize: 11, color: catObj.color, letterSpacing: 2, textTransform: "uppercase", marginBottom: 10 }}>
        {data.difficulty} · {data.topic}
      </div>
      <div style={{ fontSize: 15, color: "#eee", fontWeight: 600, lineHeight: 1.5, marginBottom: 14 }}>{data.q}</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {data.a.map((opt, i) => {
          let bg = "#1a1a1a", border = "#2a2a2a", col = "#ccc";
          if (revealed) {
            if (i === data.correct) { bg = "#1a3a1a"; border = "#4a9a4a"; col = "#7de87d"; }
            else if (i === selected && !revealed) { bg = "#3a1a1a"; border = "#9a4a4a"; col = "#e87d7d"; }
            else if (i === selected) { bg = "#3a1a1a"; border = "#9a4a4a"; col = "#e87d7d"; }
          }
          return (
            <button key={i} onClick={() => choose(i)} style={{
              background: bg, border: `1px solid ${border}`, borderRadius: 10,
              padding: "10px 14px", color: col, fontSize: 14, cursor: revealed ? "default" : "pointer",
              textAlign: "left", transition: "all 0.15s"
            }}>
              <span style={{ opacity: 0.5, marginRight: 8 }}>{["A","B","C","D"][i]})</span>{opt}
            </button>
          );
        })}
      </div>
      {revealed && (
        <div style={{ marginTop: 14, padding: "12px 14px", background: "#0e1a0e", borderRadius: 10, borderLeft: `3px solid ${selected === data.correct ? "#4a9a4a" : "#9a4a4a"}` }}>
          {loadingExp ? <span style={{ color: "#555", fontSize: 13 }}>Loading explanation...</span>
            : <span style={{ color: "#aaa", fontSize: 13, lineHeight: 1.6 }}>{explanation}</span>}
        </div>
      )}
    </div>
  );
}

// ─── SCENARIO ENGINE ──────────────────────────────────────────────────────────
const SCENARIO_INIT = {
  day: 1, alive: true, health: 100, shelter: false, fire: false, water: false, food: 0,
  log: [], location: "crash site", weather: "overcast, 28°F, light wind",
  inventory: ["lighter (low fuel)", "folding knife", "paracord 20ft", "empty water bottle", "torn jacket"],
};

function ScenarioView({ profile, onUpdate, onBack }) {
  const scenario = profile.scenario || SCENARIO_INIT;
  const [choice, setChoice] = useState("");
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState(null);
  const [options, setOptions] = useState([]);

  useEffect(() => { if (!response) loadOptions(); }, []);

  async function loadOptions() {
    setLoading(true);
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json",
          "x-api-key": getApiKey(),
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 600,
          system: `You are a brutal survival scenario engine. Current scenario state: ${JSON.stringify(scenario)}. Generate exactly 3 realistic choices for the survivor right now. Return ONLY JSON: {"situation":"one sentence current situation","choices":["choice 1","choice 2","choice 3"]}`,
          messages: [{ role: "user", content: "What are my options right now?" }]
        })
      });
      const d = await res.json();
      const text = d.content?.map(b => b.text || "").join("") || "{}";
      const clean = text.replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(clean);
      setOptions(parsed.choices || []);
      setResponse(parsed.situation || "");
    } catch { setOptions(["Scout the area", "Build shelter now", "Find water first"]); }
    setLoading(false);
  }

  async function makeChoice(c) {
    setLoading(true);
    setChoice(c);
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json",
          "x-api-key": getApiKey(),
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 800,
          system: `You are a brutal survival scenario engine set in Alaska in October. Be realistic — wrong choices have real consequences. Current state: ${JSON.stringify(scenario)}. The survivor chose: "${c}". Return ONLY JSON: {"narrative":"2-3 sentence result","health_change":-10,"new_weather":"...","new_inventory":["..."],"shelter":false,"fire":false,"water":false,"food":0,"day":${scenario.day},"survival_grade":"A|B|C|D|F","grade_reason":"one sentence"}`,
          messages: [{ role: "user", content: `I choose: ${c}` }]
        })
      });
      const d = await res.json();
      const text = d.content?.map(b => b.text || "").join("") || "{}";
      const clean = text.replace(/```json|```/g, "").trim();
      const update = JSON.parse(clean);

      const newScenario = {
        ...scenario,
        day: update.day || scenario.day + 1,
        health: Math.max(0, Math.min(100, scenario.health + (update.health_change || 0))),
        shelter: update.shelter ?? scenario.shelter,
        fire: update.fire ?? scenario.fire,
        water: update.water ?? scenario.water,
        food: update.food ?? scenario.food,
        weather: update.new_weather || scenario.weather,
        inventory: update.new_inventory || scenario.inventory,
        log: [...scenario.log, { day: scenario.day, choice: c, result: update.narrative, grade: update.survival_grade }],
      };

      onUpdate({ scenario: newScenario, xp: profile.xp + 40, catXP: { ...profile.catXP, survival: (profile.catXP.survival || 0) + 40 } });
      setResponse(update.narrative);
      setOptions([]);
      setTimeout(loadOptions, 500);
    } catch { setLoading(false); }
    setLoading(false);
  }

  const catColor = "#5a9e6f";

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", background: "#0a0f0a", fontFamily: "'Inter', system-ui, sans-serif" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 16px", background: "#0f1f0f", borderBottom: `2px solid ${catColor}` }}>
        <button onClick={onBack} style={{ background: "none", border: "none", color: catColor, fontSize: 20, cursor: "pointer" }}>←</button>
        <span style={{ fontSize: 16, fontWeight: 700, color: catColor }}>🏔️ Alaska Survival — Day {scenario.day}</span>
      </div>

      {/* Status bar */}
      <div style={{ display: "flex", gap: 12, padding: "10px 16px", background: "#0d1a0d", borderBottom: "1px solid #1a2a1a", flexWrap: "wrap" }}>
        {[
          { label: "HP", val: `${scenario.health}%`, color: scenario.health > 60 ? "#5a9a5a" : scenario.health > 30 ? "#c9a84c" : "#c05c3a" },
          { label: "Shelter", val: scenario.shelter ? "✓" : "✗", color: scenario.shelter ? "#5a9a5a" : "#c05c3a" },
          { label: "Fire", val: scenario.fire ? "✓" : "✗", color: scenario.fire ? "#c9a84c" : "#c05c3a" },
          { label: "Water", val: scenario.water ? "✓" : "✗", color: scenario.water ? "#5a9a5a" : "#c05c3a" },
          { label: "Temp", val: scenario.weather.split(",")[0], color: "#9ba8c9" },
        ].map(s => (
          <div key={s.label} style={{ fontSize: 11, color: "#555" }}>
            {s.label}: <span style={{ color: s.color, fontWeight: 700 }}>{s.val}</span>
          </div>
        ))}
      </div>

      {/* Inventory */}
      <div style={{ padding: "8px 16px", background: "#0a0f0a", borderBottom: "1px solid #151f15" }}>
        <div style={{ fontSize: 11, color: "#3a4a3a" }}>INVENTORY: {scenario.inventory.join(" · ")}</div>
      </div>

      {/* Log */}
      <div style={{ flex: 1, overflowY: "auto", padding: 16 }}>
        {scenario.log.slice(-3).map((entry, i) => (
          <div key={i} style={{ marginBottom: 12, padding: "10px 14px", background: "#0f1a0f", borderRadius: 10, borderLeft: `3px solid ${entry.grade === "A" || entry.grade === "B" ? "#5a9a5a" : "#9a5a3a"}` }}>
            <div style={{ fontSize: 11, color: "#3a5a3a", marginBottom: 4 }}>Day {entry.day} · Grade: <span style={{ color: entry.grade === "F" ? "#c05c3a" : "#5a9a5a" }}>{entry.grade}</span></div>
            <div style={{ fontSize: 13, color: "#8a9a8a", lineHeight: 1.5 }}>{entry.result}</div>
          </div>
        ))}

        {response && scenario.log.length === 0 && (
          <div style={{ padding: "12px 14px", background: "#0f1a0f", borderRadius: 10, marginBottom: 12 }}>
            <div style={{ fontSize: 13, color: "#8a9a8a", lineHeight: 1.5 }}>{response}</div>
          </div>
        )}

        {loading && <div style={{ color: "#3a5a3a", fontSize: 13, padding: "10px 0" }}>Calculating consequences...</div>}

        {!loading && options.length > 0 && (
          <div>
            <div style={{ fontSize: 11, color: "#3a5a3a", letterSpacing: 2, marginBottom: 10 }}>YOUR MOVE:</div>
            {options.map((opt, i) => (
              <button key={i} onClick={() => makeChoice(opt)} style={{
                display: "block", width: "100%", background: "#0f1a0f", border: "1px solid #2a3a2a",
                borderRadius: 10, padding: "12px 14px", color: "#8aba8a", fontSize: 14,
                cursor: "pointer", marginBottom: 8, textAlign: "left"
              }}>
                <span style={{ color: "#3a5a3a", marginRight: 8 }}>{i + 1}.</span>{opt}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── FIELD JOURNAL ────────────────────────────────────────────────────────────
function JournalView({ profile, onUpdate, onBack }) {
  const [newEntry, setNewEntry] = useState("");
  const [filter, setFilter] = useState("all");
  const entries = profile.journalEntries || [];

  function addEntry() {
    if (!newEntry.trim()) return;
    const entry = {
      id: Date.now(),
      cat: filter === "all" ? "survival" : filter,
      content: newEntry.trim(),
      ts: new Date().toISOString(),
      tags: [],
    };
    onUpdate({ journalEntries: [entry, ...entries] });
    setNewEntry("");
  }

  function deleteEntry(id) {
    onUpdate({ journalEntries: entries.filter(e => e.id !== id) });
  }

  const filtered = filter === "all" ? entries : entries.filter(e => e.cat === filter);
  const catColors = Object.fromEntries(CATS.map(c => [c.id, c.color]));

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", background: "#0d0d0d", fontFamily: "'Inter', system-ui, sans-serif" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 16px", background: "#1a1a14", borderBottom: "2px solid #c9a84c" }}>
        <button onClick={onBack} style={{ background: "none", border: "none", color: "#c9a84c", fontSize: 20, cursor: "pointer" }}>←</button>
        <span style={{ fontSize: 16, fontWeight: 700, color: "#c9a84c" }}>📓 Field Journal</span>
        <span style={{ marginLeft: "auto", fontSize: 12, color: "#555" }}>{entries.length} entries</span>
      </div>

      <div style={{ padding: "10px 16px", display: "flex", gap: 8, overflowX: "auto", borderBottom: "1px solid #1a1a1a" }}>
        {["all", ...CATS.map(c => c.id)].map(f => (
          <button key={f} onClick={() => setFilter(f)} style={{
            background: filter === f ? "#1a1a14" : "transparent",
            border: `1px solid ${filter === f ? "#c9a84c" : "#222"}`,
            borderRadius: 16, padding: "4px 12px", color: filter === f ? "#c9a84c" : "#555",
            fontSize: 12, cursor: "pointer", whiteSpace: "nowrap"
          }}>{f === "all" ? "All" : CATS.find(c => c.id === f)?.label}</button>
        ))}
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: 16 }}>
        {filtered.length === 0 && (
          <div style={{ textAlign: "center", color: "#333", fontSize: 14, marginTop: 40 }}>No entries yet. Start logging what you learn.</div>
        )}
        {filtered.map(e => (
          <div key={e.id} style={{ background: "#111", border: "1px solid #1e1e1e", borderRadius: 12, padding: 14, marginBottom: 10, borderLeft: `3px solid ${catColors[e.cat] || "#555"}` }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
              <span style={{ fontSize: 11, color: catColors[e.cat] || "#555", textTransform: "uppercase", letterSpacing: 1 }}>{e.cat}</span>
              <span style={{ fontSize: 11, color: "#333" }}>{new Date(e.ts).toLocaleDateString()}</span>
            </div>
            <div style={{ fontSize: 14, color: "#ccc", lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{e.content}</div>
            <button onClick={() => deleteEntry(e.id)} style={{ marginTop: 8, background: "none", border: "none", color: "#333", fontSize: 12, cursor: "pointer" }}>delete</button>
          </div>
        ))}
      </div>

      <div style={{ padding: "12px 16px", background: "#111", borderTop: "1px solid #1a1a1a", display: "flex", gap: 10 }}>
        <select value={filter === "all" ? "survival" : filter} onChange={e => setFilter(e.target.value)}
          style={{ background: "#1a1a1a", border: "1px solid #2a2a2a", borderRadius: 8, padding: "8px 10px", color: "#ccc", fontSize: 13 }}>
          {CATS.map(c => <option key={c.id} value={c.id}>{c.icon} {c.label}</option>)}
        </select>
        <input value={newEntry} onChange={e => setNewEntry(e.target.value)}
          onKeyDown={e => e.key === "Enter" && !e.shiftKey && (e.preventDefault(), addEntry())}
          placeholder="Log what you learned..."
          style={{ flex: 1, background: "#1a1a1a", border: "1px solid #2a2a2a", borderRadius: 8, padding: "8px 12px", color: "#f0f0f0", fontSize: 14, outline: "none" }} />
        <button onClick={addEntry} style={{ background: "#c9a84c", border: "none", borderRadius: 8, padding: "8px 14px", color: "#000", fontWeight: 700, cursor: "pointer", fontSize: 13 }}>+</button>
      </div>
    </div>
  );
}

// ─── MAIN CHAT VIEW ────────────────────────────────────────────────────────────
function ChatView({ catId, profile, onUpdate, onBack }) {
  const cat = CATS.find(c => c.id === catId);
  const [messages, setMessages] = useState(profile.sessions?.[catId] || []);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState("chat"); // chat | trivia | recall
  const [triviaData, setTriviaData] = useState(null);
  const [triviaScore, setTriviaScore] = useState({ correct: 0, total: 0 });
  const bottomRef = useRef(null);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, loading, triviaData]);

  function persistSession(msgs) {
    const sessions = { ...(profile.sessions || {}), [catId]: msgs.slice(-20) };
    onUpdate({ sessions, totalSessions: (profile.totalSessions || 0) + 1 });
  }

  async function sendMessage(text) {
    if (!text.trim() || loading) return;
    const userMsg = { role: "user", content: text.trim() };
    const newMsgs = [...messages, userMsg];
    setMessages(newMsgs);
    setInput("");
    setLoading(true);

    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json",
          "x-api-key": getApiKey(),
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1200,
          system: buildSystemPrompt(catId, profile, mode),
          messages: newMsgs,
        })
      });
      const data = await res.json();
      const reply = data.content?.map(b => b.text || "").join("") || "No response.";
      const updated = [...newMsgs, { role: "assistant", content: reply }];
      setMessages(updated);
      persistSession(updated);
      onUpdate({ xp: profile.xp + 5, catXP: { ...profile.catXP, [catId]: (profile.catXP[catId] || 0) + 5 } });
    } catch {
      const err = [...newMsgs, { role: "assistant", content: "Connection error. Try again." }];
      setMessages(err);
    }
    setLoading(false);
  }

  async function fetchTrivia() {
    setLoading(true);
    setTriviaData(null);
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json",
          "x-api-key": getApiKey(),
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 400,
          system: buildSystemPrompt(catId, profile, "TRIVIA"),
          messages: [{ role: "user", content: "Give me one trivia question. Return ONLY the JSON object, no other text." }]
        })
      });
      const data = await res.json();
      const text = data.content?.map(b => b.text || "").join("") || "{}";
      const clean = text.replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(clean);
      setTriviaData(parsed);
    } catch { setTriviaData(null); }
    setLoading(false);
  }

  function handleTriviaResult(correct, topic, difficulty) {
    const xpGain = correct ? (difficulty === "hard" ? 25 : difficulty === "medium" ? 15 : 10) : 0;
    const newScore = { correct: triviaScore.correct + (correct ? 1 : 0), total: triviaScore.total + 1 };
    setTriviaScore(newScore);

    const weakSpots = { ...(profile.weakSpots || {}) };
    if (!weakSpots[catId]) weakSpots[catId] = {};
    if (!correct) {
      weakSpots[catId][topic] = (weakSpots[catId][topic] || 0) + 1;
    } else if (weakSpots[catId][topic] > 0) {
      weakSpots[catId][topic] = Math.max(0, weakSpots[catId][topic] - 1);
    }

    const history = [...(profile.triviaHistory || []), { cat: catId, topic, correct, mode: "multiple", ts: Date.now() }];
    onUpdate({ xp: profile.xp + xpGain, catXP: { ...profile.catXP, [catId]: (profile.catXP[catId] || 0) + xpGain }, weakSpots, triviaHistory: history });

    setTimeout(fetchTrivia, 1800);
  }

  const STARTERS = {
    survival: ["How do I find water in Alaska?", "Build emergency shelter fast", "Hypothermia treatment field protocol", "Improvised fire starting methods"],
    history: ["Why did the US enter WWI?", "Explain Reconstruction", "What was the Cold War really about?", "Vietnam — why did we lose?"],
    firearms: ["What is the M27 IAR?", "Pronounce 'Heckler & Koch'", "M4 vs M16 — actual differences", "What does MOA mean?"],
    wildlife: ["Grizzly vs black bear attack — different responses?", "Most venomous snakes in North America", "Moose danger — underrated?", "What to do after a snake bite"],
    plants: ["Most deadly mushrooms in Alaska", "Water hemlock identification", "Safe berries vs deadly lookalikes", "Death camas — what is it?"],
    books: ["Best survival books ever written", "Marine Corps reading list", "Alaskan wilderness books", "Stoic philosophy books for discipline"],
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", background: "#0d0d0d", fontFamily: "'Inter', system-ui, sans-serif" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", background: cat.dim, borderBottom: `2px solid ${cat.color}` }}>
        <button onClick={onBack} style={{ background: "none", border: "none", color: cat.color, fontSize: 20, cursor: "pointer" }}>←</button>
        <span style={{ fontSize: 16, fontWeight: 700, color: cat.color }}>{cat.icon} {cat.label}</span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
          {["chat", "trivia", "recall"].map(m => (
            <button key={m} onClick={() => { setMode(m); if (m === "trivia") fetchTrivia(); }} style={{
              background: mode === m ? cat.color : "transparent",
              border: `1px solid ${mode === m ? cat.color : "#333"}`,
              borderRadius: 6, padding: "3px 10px", color: mode === m ? "#000" : "#555",
              fontSize: 11, cursor: "pointer", fontWeight: mode === m ? 700 : 400, textTransform: "uppercase"
            }}>{m}</button>
          ))}
        </div>
      </div>

      {/* Trivia score bar */}
      {mode === "trivia" && triviaScore.total > 0 && (
        <div style={{ padding: "6px 16px", background: "#111", borderBottom: "1px solid #1a1a1a", display: "flex", gap: 16 }}>
          <span style={{ fontSize: 12, color: "#5a9a5a" }}>✓ {triviaScore.correct}</span>
          <span style={{ fontSize: 12, color: "#9a5a5a" }}>✗ {triviaScore.total - triviaScore.correct}</span>
          <span style={{ fontSize: 12, color: "#555" }}>{Math.round(triviaScore.correct / triviaScore.total * 100)}% accuracy</span>
        </div>
      )}

      {/* Content */}
      <div style={{ flex: 1, overflowY: "auto", padding: 16 }}>
        {mode === "trivia" ? (
          <div>
            {loading && !triviaData && <div style={{ color: "#555", fontSize: 13 }}>Loading question...</div>}
            {triviaData && <TriviaCard data={triviaData} onResult={handleTriviaResult} profile={profile} cat={catId} />}
            <button onClick={fetchTrivia} disabled={loading} style={{
              background: "transparent", border: `1px solid ${cat.color}40`, borderRadius: 8,
              padding: "10px 20px", color: cat.color, fontSize: 13, cursor: "pointer", opacity: loading ? 0.4 : 1
            }}>Next question →</button>
          </div>
        ) : (
          <div>
            {messages.length === 0 && (
              <div style={{ marginBottom: 20 }}>
                <div style={{ fontSize: 11, color: "#333", letterSpacing: 2, marginBottom: 12 }}>QUICK START</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {STARTERS[catId].map(s => (
                    <button key={s} onClick={() => sendMessage(s)} style={{
                      background: cat.dim, border: `1px solid ${cat.color}30`, color: cat.color,
                      padding: "10px 14px", borderRadius: 10, fontSize: 13, cursor: "pointer", textAlign: "left"
                    }}>{s}</button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} style={{ display: "flex", justifyContent: m.role === "user" ? "flex-end" : "flex-start", marginBottom: 12 }}>
                <div style={{
                  maxWidth: "82%", padding: "10px 14px",
                  borderRadius: m.role === "user" ? "14px 14px 4px 14px" : "14px 14px 14px 4px",
                  background: m.role === "user" ? cat.color : "#161616",
                  color: m.role === "user" ? "#000" : "#ddd",
                  fontSize: 14, lineHeight: 1.65, border: m.role === "user" ? "none" : "1px solid #222",
                  whiteSpace: "pre-wrap", wordBreak: "break-word"
                }}>{m.content}</div>
              </div>
            ))}
            {loading && (
              <div style={{ display: "flex", gap: 5, padding: "10px 14px", background: "#161616", borderRadius: 10, width: "fit-content", border: "1px solid #222" }}>
                {[0,1,2].map(i => <div key={i} style={{ width: 6, height: 6, borderRadius: "50%", background: "#444", animation: "pulse 1.2s infinite", animationDelay: `${i*0.2}s` }} />)}
              </div>
            )}
            <div ref={bottomRef} />
          </div>
        )}
      </div>

      {/* Input — hidden in trivia mode */}
      {mode !== "trivia" && (
        <div style={{ padding: "12px 16px", background: "#111", borderTop: "1px solid #1a1a1a", display: "flex", gap: 10 }}>
          <input value={input} onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === "Enter" && !e.shiftKey && (e.preventDefault(), sendMessage(input))}
            placeholder={mode === "recall" ? "Answer from memory..." : "Ask anything..."}
            style={{ flex: 1, background: "#1a1a1a", border: `1px solid ${cat.color}30`, borderRadius: 22, padding: "10px 16px", color: "#f0f0f0", fontSize: 14, outline: "none" }} />
          <button onClick={() => sendMessage(input)} disabled={loading || !input.trim()} style={{
            background: cat.color, border: "none", borderRadius: "50%", width: 42, height: 42,
            cursor: "pointer", fontSize: 16, opacity: loading || !input.trim() ? 0.4 : 1,
            flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "#000", fontWeight: 700
          }}>↑</button>
        </div>
      )}
      <style>{`@keyframes pulse{0%,80%,100%{transform:translateY(0);opacity:.3}40%{transform:translateY(-5px);opacity:1}}*{box-sizing:border-box}::-webkit-scrollbar{width:3px}::-webkit-scrollbar-thumb{background:#222;border-radius:4px}`}</style>
    </div>
  );
}

// ─── API KEY SCREEN ───────────────────────────────────────────────────────────
function ApiKeyScreen({ onSave }) {
  const [key, setKey] = useState("");
  const [error, setError] = useState("");

  function save() {
    if (!key.startsWith("sk-ant-")) {
      setError("Key should start with sk-ant-");
      return;
    }
    setApiKey(key.trim());
    onSave();
  }

  return (
    <div style={{ minHeight: "100vh", background: "#0a0a0a", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, fontFamily: "'Inter', system-ui, sans-serif" }}>
      <div style={{ maxWidth: 360, width: "100%" }}>
        <div style={{ fontSize: 10, color: "#333", letterSpacing: 3, textTransform: "uppercase", marginBottom: 8 }}>OPERATOR SYSTEM</div>
        <h1 style={{ fontSize: 26, fontWeight: 900, color: "#f0f0f0", margin: "0 0 8px", letterSpacing: -1 }}>Enter API Key</h1>
        <p style={{ fontSize: 13, color: "#444", lineHeight: 1.6, marginBottom: 24 }}>
          Get your free key at <span style={{ color: "#c9a84c" }}>console.anthropic.com</span> → API Keys → Create Key. It stays on your device only.
        </p>
        <input
          value={key}
          onChange={e => { setKey(e.target.value); setError(""); }}
          onKeyDown={e => e.key === "Enter" && save()}
          placeholder="sk-ant-..."
          type="password"
          style={{ width: "100%", background: "#141414", border: "1px solid #2a2a2a", borderRadius: 10, padding: "12px 16px", color: "#f0f0f0", fontSize: 14, outline: "none", marginBottom: 10, boxSizing: "border-box" }}
        />
        {error && <div style={{ color: "#c05c3a", fontSize: 12, marginBottom: 10 }}>{error}</div>}
        <button onClick={save} style={{ width: "100%", background: "#c9a84c", border: "none", borderRadius: 10, padding: "12px", color: "#000", fontWeight: 700, fontSize: 15, cursor: "pointer" }}>
          Activate Operator
        </button>
        <div style={{ marginTop: 16, fontSize: 11, color: "#333", textAlign: "center" }}>Key is saved locally to your device. Never shared.</div>
      </div>
    </div>
  );
}

// ─── HOME SCREEN ──────────────────────────────────────────────────────────────
export default function App() {
  const [profile, setProfile] = useState(loadProfile);
  const [view, setView] = useState("home"); // home | cat:id | scenario | journal | missions
  const [toast, setToast] = useState(null);
  const [hasKey, setHasKey] = useState(!!getApiKey());

  if (!hasKey) return <ApiKeyScreen onSave={() => setHasKey(true)} />;

  // Streak check on mount
  useEffect(() => {
    const today = new Date().toDateString();
    if (profile.lastActive !== today) {
      const yesterday = new Date(Date.now() - 86400000).toDateString();
      const newStreak = profile.lastActive === yesterday ? (profile.streak || 0) + 1 : 1;
      updateProfile({ lastActive: today, streak: newStreak });
    }
  }, []);

  function updateProfile(updates) {
    setProfile(prev => {
      const next = { ...prev, ...updates };
      saveProfile(next);
      return next;
    });
  }

  function showToast(msg) {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  }

  const rank = getRank(profile.xp);
  const nextRank = getNextRank(profile.xp);
  const xpToNext = nextRank ? nextRank.xp - profile.xp : 0;
  const xpProgress = nextRank ? ((profile.xp - rank.xp) / (nextRank.xp - rank.xp)) * 100 : 100;
  const daysOut = Math.max(0, Math.ceil((new Date(profile.shipDate) - new Date()) / 86400000));
  const missions = generateMissions(profile);
  const doneMissions = missions.filter(m => m.done).length;

  // Weak spots summary
  const topWeak = Object.entries(profile.weakSpots)
    .flatMap(([cat, topics]) => Object.entries(topics).map(([t, c]) => ({ cat, topic: t, count: c })))
    .filter(w => w.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 3);

  if (view.startsWith("cat:")) return <ChatView catId={view.split(":")[1]} profile={profile} onUpdate={updateProfile} onBack={() => setView("home")} />;
  if (view === "scenario") return <ScenarioView profile={profile} onUpdate={updateProfile} onBack={() => setView("home")} />;
  if (view === "journal") return <JournalView profile={profile} onUpdate={updateProfile} onBack={() => setView("home")} />;

  return (
    <div style={{ minHeight: "100vh", background: "#0a0a0a", fontFamily: "'Inter', system-ui, sans-serif", paddingBottom: 40 }}>
      <div style={{ maxWidth: 440, margin: "0 auto", padding: "0 16px" }}>

        {/* Header */}
        <div style={{ padding: "24px 0 16px" }}>
          <div style={{ fontSize: 10, color: "#333", letterSpacing: 3, textTransform: "uppercase", marginBottom: 4 }}>OPERATOR SYSTEM</div>
          <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between" }}>
            <div>
              <h1 style={{ fontSize: 28, fontWeight: 900, color: "#f0f0f0", margin: 0, letterSpacing: -1 }}>{profile.name}</h1>
              <div style={{ fontSize: 13, color: "#444", marginTop: 2 }}>{rank.badge} {rank.name} · {profile.xp} XP</div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 22, fontWeight: 900, color: "#c9a84c" }}>{daysOut}</div>
              <div style={{ fontSize: 10, color: "#444", letterSpacing: 1 }}>DAYS OUT</div>
            </div>
          </div>

          {/* XP bar */}
          {nextRank && (
            <div style={{ marginTop: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                <span style={{ fontSize: 11, color: "#333" }}>{rank.name}</span>
                <span style={{ fontSize: 11, color: "#333" }}>{xpToNext} XP to {nextRank.name}</span>
              </div>
              <div style={{ height: 3, background: "#1a1a1a", borderRadius: 2 }}>
                <div style={{ height: "100%", width: `${xpProgress}%`, background: "#c9a84c", borderRadius: 2, transition: "width 0.5s" }} />
              </div>
            </div>
          )}

          {/* Streak */}
          <div style={{ display: "flex", gap: 16, marginTop: 12 }}>
            <div style={{ fontSize: 12, color: profile.streak >= 3 ? "#c9a84c" : "#333" }}>
              🔥 {profile.streak} day streak
            </div>
            <div style={{ fontSize: 12, color: "#333" }}>
              ✓ {doneMissions}/{missions.length} missions today
            </div>
            <div style={{ fontSize: 12, color: "#333" }}>
              {profile.journalEntries?.length || 0} journal entries
            </div>
          </div>
        </div>

        {/* Daily Missions */}
        <div style={{ background: "#111", border: "1px solid #1a1a1a", borderRadius: 14, padding: 16, marginBottom: 16 }}>
          <div style={{ fontSize: 11, color: "#444", letterSpacing: 2, textTransform: "uppercase", marginBottom: 12 }}>Today's Missions</div>
          {missions.map((m, i) => {
            const cat = CATS.find(c => c.id === m.cat);
            return (
              <div key={i} onClick={() => setView(m.type === "scenario" ? "scenario" : `cat:${m.cat}`)}
                style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 0",
                  borderBottom: i < missions.length - 1 ? "1px solid #161616" : "none", cursor: "pointer" }}>
                <div style={{ width: 8, height: 8, borderRadius: "50%", background: m.done ? "#5a9a5a" : (cat?.color || "#555"), flexShrink: 0 }} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, color: m.done ? "#444" : "#ccc", textDecoration: m.done ? "line-through" : "none" }}>{m.task}</div>
                </div>
                <div style={{ fontSize: 11, color: "#333" }}>+{m.xp}xp</div>
              </div>
            );
          })}
        </div>

        {/* Weak Spots */}
        {topWeak.length > 0 && (
          <div style={{ background: "#110a0a", border: "1px solid #2a1a1a", borderRadius: 14, padding: 16, marginBottom: 16 }}>
            <div style={{ fontSize: 11, color: "#7a3a3a", letterSpacing: 2, textTransform: "uppercase", marginBottom: 10 }}>Weak Spots — Drill These</div>
            {topWeak.map((w, i) => (
              <div key={i} onClick={() => setView(`cat:${w.cat}`)} style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 8, cursor: "pointer" }}>
                <div style={{ width: 3, height: 3, borderRadius: "50%", background: "#c05c3a" }} />
                <span style={{ fontSize: 13, color: "#9a5a5a" }}>{w.topic}</span>
                <span style={{ fontSize: 11, color: "#5a2a2a", marginLeft: "auto" }}>missed {w.count}×</span>
              </div>
            ))}
          </div>
        )}

        {/* Categories */}
        <div style={{ fontSize: 11, color: "#333", letterSpacing: 2, textTransform: "uppercase", marginBottom: 10 }}>Knowledge Domains</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 16 }}>
          {CATS.map(cat => {
            const catXP = profile.catXP?.[cat.id] || 0;
            const catRank = getRank(catXP);
            return (
              <button key={cat.id} onClick={() => setView(`cat:${cat.id}`)} style={{
                background: cat.dim, border: `1px solid ${cat.color}30`,
                borderRadius: 12, padding: "14px 14px",
                cursor: "pointer", textAlign: "left", transition: "border-color 0.15s"
              }}
                onMouseEnter={e => e.currentTarget.style.borderColor = cat.color}
                onMouseLeave={e => e.currentTarget.style.borderColor = cat.color + "30"}>
                <div style={{ fontSize: 20, marginBottom: 6 }}>{cat.icon}</div>
                <div style={{ fontSize: 13, fontWeight: 700, color: cat.color }}>{cat.label}</div>
                <div style={{ fontSize: 11, color: "#333", marginTop: 3 }}>{catRank.name} · {catXP}xp</div>
              </button>
            );
          })}
        </div>

        {/* Special Modes */}
        <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
          <button onClick={() => setView("scenario")} style={{
            flex: 1, background: "#0f1a0f", border: "1px solid #2a3a2a", borderRadius: 12,
            padding: "14px", cursor: "pointer", textAlign: "left"
          }}>
            <div style={{ fontSize: 18, marginBottom: 4 }}>🏔️</div>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#5a9e6f" }}>Alaska Scenario</div>
            <div style={{ fontSize: 11, color: "#2a4a2a", marginTop: 2 }}>Day {profile.scenario?.day || 1} active</div>
          </button>
          <button onClick={() => setView("journal")} style={{
            flex: 1, background: "#1a1a14", border: "1px solid #3a3a2a", borderRadius: 12,
            padding: "14px", cursor: "pointer", textAlign: "left"
          }}>
            <div style={{ fontSize: 18, marginBottom: 4 }}>📓</div>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#c9a84c" }}>Field Journal</div>
            <div style={{ fontSize: 11, color: "#4a4a2a", marginTop: 2 }}>{profile.journalEntries?.length || 0} entries logged</div>
          </button>
        </div>

        {/* Low effort mode */}
        <LowEffortMode profile={profile} onUpdate={updateProfile} />

      </div>

      {/* Toast */}
      {toast && (
        <div style={{ position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)", background: "#1a2a1a", border: "1px solid #3a5a3a", borderRadius: 20, padding: "10px 20px", color: "#7aba7a", fontSize: 13, zIndex: 999 }}>{toast}</div>
      )}
    </div>
  );
}

// ─── LOW EFFORT MODE ──────────────────────────────────────────────────────────
function LowEffortMode({ profile, onUpdate }) {
  const [fact, setFact] = useState(null);
  const [loading, setLoading] = useState(false);

  async function getDailyFact() {
    setLoading(true);
    const cats = ["survival", "history", "firearms", "wildlife", "plants"];
    const randomCat = cats[Math.floor(Math.random() * cats.length)];
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json",
          "x-api-key": getApiKey(),
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 200,
          system: `You are a field instructor. Give exactly ONE fascinating, field-critical fact relevant to a future Marine heading to Alaska. Category: ${randomCat}. 2-3 sentences max. Make it something they'll remember because it's surprising or life-relevant.`,
          messages: [{ role: "user", content: "Give me my one fact for today." }]
        })
      });
      const d = await res.json();
      const text = d.content?.map(b => b.text || "").join("") || "";
      setFact({ text, cat: randomCat });
      onUpdate({ xp: profile.xp + 3 });
    } catch { setFact({ text: "Connection error.", cat: "survival" }); }
    setLoading(false);
  }

  const catObj = fact ? CATS.find(c => c.id === fact.cat) : null;

  return (
    <div style={{ background: "#0f0f14", border: "1px solid #1a1a2a", borderRadius: 14, padding: 16 }}>
      <div style={{ fontSize: 11, color: "#333", letterSpacing: 2, textTransform: "uppercase", marginBottom: 10 }}>Low-Effort Mode — 1 Fact</div>
      {fact ? (
        <div>
          <div style={{ fontSize: 11, color: catObj?.color || "#555", marginBottom: 6, textTransform: "uppercase", letterSpacing: 1 }}>{fact.cat}</div>
          <div style={{ fontSize: 14, color: "#bbb", lineHeight: 1.65 }}>{fact.text}</div>
          <button onClick={() => setFact(null)} style={{ marginTop: 10, background: "none", border: "none", color: "#333", fontSize: 12, cursor: "pointer" }}>get another →</button>
        </div>
      ) : (
        <button onClick={getDailyFact} disabled={loading} style={{
          width: "100%", background: "transparent", border: "1px dashed #222", borderRadius: 10,
          padding: "12px", color: "#333", fontSize: 13, cursor: "pointer", opacity: loading ? 0.5 : 1
        }}>{loading ? "Loading..." : "Too tired to study? Tap for one fact. +3xp"}</button>
      )}
    </div>
  );
}