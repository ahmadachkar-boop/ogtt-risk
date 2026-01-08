"use client"
import React, { useMemo, useState } from "react";

/**
 * OGTT-DM Risk Stratifier
 * Source logic:
 * - Figure 1: Stepwise Risk Stratification (ADA 2025 screening triggers + ATP III MetS + OGTT high-risk markers + age-based eligibility)
 * - Supplementary Table 1: Matsuda index, HOMA-IR
 * - Supplementary Table 2: IGI, Stumvoll 1st/2nd phase, DI, HOMA-β, PG AUC (weighted)
 *
 * Notes:
 * - Glucose inputs are mg/dL; insulin inputs are mU/L (µU/mL).
 * - Stumvoll equations require glucose in mmol/L and insulin in pmol/L.
 *   Conversion: insulin_pmol = insulin_mU_L * 6; glucose_mmol = glucose_mg_dL / 18
 * - PG AUC formula implemented as provided (weighted mean of 0/30/60/120 only; 90-min not used).
 * - This app is intended for clinician use as decision support/education. It stores no data.
 */

// ---------- Helpers ----------
const clampNum = (v: any, min: number, max: number) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(max, Math.max(min, n));
};

const fmt = (v: number | undefined, digits = 2) =>
  v === undefined || Number.isNaN(v) ? "—" : v.toFixed(digits);

const pctFmt = (v: number | undefined, digits = 1) =>
  v === undefined || Number.isNaN(v) ? "—" : `${v.toFixed(digits)}%`;

const sqrt = (x: number) => Math.sqrt(x);

function mean(vals: Array<number | undefined>) {
  const v = vals.filter((x): x is number => typeof x === "number" && Number.isFinite(x));
  if (!v.length) return undefined;
  return v.reduce((a, b) => a + b, 0) / v.length;
}

function safeDiv(a?: number, b?: number) {
  if (a === undefined || b === undefined) return undefined;
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return undefined;
  return a / b;
}

// ---------- Clinical cutoffs / definitions (from uploaded docs) ----------
// IFG: FPG 100–125 mg/dL; IGT: 2h PG 140–199 mg/dL
const isIFG = (g0?: number) => g0 !== undefined && g0 >= 100 && g0 < 126;
const isIGT = (g120?: number) => g120 !== undefined && g120 >= 140 && g120 < 200;

// ---------- UI components ----------
function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-100 px-5 py-4">
        <div className="text-lg font-semibold text-slate-900">{title}</div>
        {subtitle ? <div className="mt-1 text-sm text-slate-600">{subtitle}</div> : null}
      </div>
      <div className="px-5 py-5">{children}</div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  unit,
  type = "number",
  step,
  min,
  max,
  hint,
}: {
  label: string;
  value: any;
  onChange: (v: string) => void;
  placeholder?: string;
  unit?: string;
  type?: string;
  step?: string;
  min?: number;
  max?: number;
  hint?: string;
}) {
  return (
    <div className="space-y-1">
      <label className="text-sm font-medium text-slate-800">{label}</label>
      <div className="flex items-center gap-2">
        <input
          className="flex-1 min-w-[80px] rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-slate-200"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          type={type}
          step={step}
          min={min}
          max={max}
        />
        {unit ? <div className="text-sm text-slate-500 whitespace-nowrap">{unit}</div> : null}
      </div>
      {hint ? <div className="text-xs text-slate-500">{hint}</div> : null}
    </div>
  );
}

function Toggle({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string }) {
  return (
    <label className="flex items-start gap-3 rounded-xl border border-slate-200 px-3 py-2">
      <input type="checkbox" className="mt-1" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <div>
        <div className="text-sm font-medium text-slate-800">{label}</div>
        {hint ? <div className="text-xs text-slate-500">{hint}</div> : null}
      </div>
    </label>
  );
}

function Badge({ tone, children }: { tone: "ok" | "warn" | "danger" | "neutral"; children: React.ReactNode }) {
  const cls =
    tone === "ok"
      ? "bg-emerald-50 text-emerald-700 border-emerald-200"
      : tone === "warn"
      ? "bg-amber-50 text-amber-800 border-amber-200"
      : tone === "danger"
      ? "bg-rose-50 text-rose-700 border-rose-200"
      : "bg-slate-50 text-slate-700 border-slate-200";
  return <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold ${cls}`}>{children}</span>;
}

function ListItem({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2">
      <div className="text-sm text-slate-700">{k}</div>
      <div className="text-sm font-medium text-slate-900 text-right">{v}</div>
    </div>
  );
}

// ---------- Main App ----------
export default function App() {
  // Step 0: demographics / baseline
  const [baseline, setBaseline] = useState<null | {
    timestamp: string;
    weightKg?: number;
    bmi?: number;
    metsPresent: boolean;
    highRisk: boolean;
    exactRisk?: string;
    flags: string[];
    matsuda?: number;
    homaIR?: number;
    igi?: number;
    stumvoll1?: number;
    pgAuc?: number;
  }>(null);

  const clearBaseline = () => setBaseline(null);

  const [toolName] = useState("OGTT-DM Risk Stratifier");

  const [age, setAge] = useState("");
  const [sex, setSex] = useState<"female" | "male" | "">("");

  const [ethnicity, setEthnicity] = useState<
    "" | "African American" | "Hispanic/Latino" | "Native American" | "Asian American" | "White" | "Other"
  >("");

  const [weightKg, setWeightKg] = useState("");
  const [heightCm, setHeightCm] = useState("");

  const [waistCm, setWaistCm] = useState("");
  const [sbp, setSbp] = useState("");
  const [dbp, setDbp] = useState("");
  const [onBPtx, setOnBPtx] = useState(false);

  const [tg, setTg] = useState("");
  const [hdl, setHdl] = useState("");

  const [a1c, setA1c] = useState("");

  // Step 1 OGTT triggers (history/risk factors)
  const [hxGDM, setHxGDM] = useState(false);
  const [hxPancreatitis, setHxPancreatitis] = useState(false);
  const [hasMASLD, setHasMASLD] = useState(false);
  const [hasPCOS, setHasPCOS] = useState(false);
  const [fhxT2D, setFhxT2D] = useState(false);

  // OGTT values: glucose mg/dL; insulin mU/L
  const [g0, setG0] = useState("");
  const [g30, setG30] = useState("");
  const [g60, setG60] = useState("");
  const [g90, setG90] = useState("");
  const [g120, setG120] = useState("");

  const [i0, setI0] = useState("");
  const [i30, setI30] = useState("");
  const [i60, setI60] = useState("");
  const [i90, setI90] = useState("");
  const [i120, setI120] = useState("");

  // Parse numeric values (light clamping to avoid absurd typos)
  const nAge = clampNum(age, 10, 100);
  const nWeight = clampNum(weightKg, 20, 300);
  const nHeight = clampNum(heightCm, 100, 230);
  const nWaist = clampNum(waistCm, 40, 200);
  const nSBP = clampNum(sbp, 60, 260);
  const nDBP = clampNum(dbp, 30, 160);
  const nTG = clampNum(tg, 20, 2000);
  const nHDL = clampNum(hdl, 5, 200);
  const nA1c = clampNum(a1c, 3.5, 15);

  const ng0 = clampNum(g0, 40, 600);
  const ng30 = clampNum(g30, 40, 600);
  const ng60 = clampNum(g60, 40, 600);
  const ng90 = clampNum(g90, 40, 600);
  const ng120 = clampNum(g120, 40, 600);

  const ni0 = clampNum(i0, 0, 1000);
  const ni30 = clampNum(i30, 0, 2000);
  const ni60 = clampNum(i60, 0, 3000);
  const ni90 = clampNum(i90, 0, 3000);
  const ni120 = clampNum(i120, 0, 3000);

  // Derived anthropometrics
  const bmi = useMemo(() => {
    if (nWeight === undefined || nHeight === undefined) return undefined;
    const m = nHeight / 100;
    if (!m) return undefined;
    return nWeight / (m * m);
  }, [nWeight, nHeight]);

  const isAsian = ethnicity === "Asian American";
  const highRiskEthnicity = ["African American", "Hispanic/Latino", "Native American", "Asian American"].includes(ethnicity);

  // ---------- STEP 1: OGTT Indication (Figure 1) ----------
  const ogttIndication = useMemo(() => {
    const reasons: string[] = [];

    // Direct triggers
    if (ng0 !== undefined && ng0 >= 100 && ng0 < 126) reasons.push("FPG 100–125 mg/dL");
    if (nA1c !== undefined && nA1c >= 5.7 && nA1c <= 6.4) reasons.push("HbA1c 5.7–6.4%");
    if (hxGDM) reasons.push("History of gestational diabetes");
    if (hxPancreatitis) reasons.push("History of pancreatitis");

    // BMI + ≥1 risk factor
    const bmiThreshold = isAsian ? 23 : 25;
    const meetsBMI = bmi !== undefined && bmi >= bmiThreshold;

    const riskFactors = [
      { ok: hasMASLD, label: "MASLD" },
      { ok: (nSBP !== undefined && nDBP !== undefined && (nSBP >= 130 || nDBP >= 80)) || onBPtx, label: "Hypertension (≥130/80 or on treatment)" },
      { ok: (nHDL !== undefined && nHDL < 35) || (nTG !== undefined && nTG > 250), label: "Dyslipidemia (HDL <35 or TG >250)" },
      { ok: hasPCOS, label: "PCOS" },
      { ok: fhxT2D, label: "First-degree relative with T2D" },
      { ok: highRiskEthnicity, label: "High-risk ethnicity" },
    ];

    const rfMet = riskFactors.filter((x) => x.ok);

    if (meetsBMI && rfMet.length >= 1) {
      reasons.push(`BMI ≥${bmiThreshold} kg/m² plus risk factor(s): ${rfMet.map((r) => r.label).join(", ")}`);
    }

    const indicated = reasons.length > 0;
    return { indicated, reasons };
  }, [ng0, nA1c, hxGDM, hxPancreatitis, bmi, isAsian, hasMASLD, nSBP, nDBP, onBPtx, nHDL, nTG, hasPCOS, fhxT2D, highRiskEthnicity]);

  // ---------- STEP 2: Metabolic Syndrome (ATP III) ----------
  const metabolicSyndrome = useMemo(() => {
    const criteria: Array<{ name: string; met: boolean; detail?: string }> = [];

    // Waist
    if (sex && nWaist !== undefined) {
      const waistMet = sex === "male" ? nWaist > 102 : nWaist > 88;
      criteria.push({ name: "Waist circumference", met: waistMet, detail: sex === "male" ? ">102 cm" : ">88 cm" });
    } else {
      criteria.push({ name: "Waist circumference", met: false, detail: "Enter sex + waist" });
    }

    // TG
    if (nTG !== undefined) criteria.push({ name: "Triglycerides", met: nTG >= 150, detail: "≥150 mg/dL" });
    else criteria.push({ name: "Triglycerides", met: false, detail: "Enter TG" });

    // HDL
    if (sex && nHDL !== undefined) {
      const hdlMet = sex === "male" ? nHDL < 40 : nHDL < 50;
      criteria.push({ name: "HDL", met: hdlMet, detail: sex === "male" ? "<40 mg/dL" : "<50 mg/dL" });
    } else {
      criteria.push({ name: "HDL", met: false, detail: "Enter sex + HDL" });
    }

    // BP
    if (onBPtx) criteria.push({ name: "Blood pressure", met: true, detail: "On treatment" });
    else if (nSBP !== undefined && nDBP !== undefined) criteria.push({ name: "Blood pressure", met: nSBP >= 130 || nDBP >= 85, detail: "≥130/85" });
    else criteria.push({ name: "Blood pressure", met: false, detail: "Enter BP or treatment" });

    // FPG
    if (ng0 !== undefined) criteria.push({ name: "Fasting glucose", met: ng0 >= 100, detail: "≥100 mg/dL" });
    else criteria.push({ name: "Fasting glucose", met: false, detail: "Enter fasting glucose" });

    const metCount = criteria.reduce((acc, c) => acc + (c.met ? 1 : 0), 0);
    const present = metCount >= 3;

    return { present, metCount, criteria };
  }, [sex, nWaist, nTG, nHDL, onBPtx, nSBP, nDBP, ng0]);

  // ---------- Indices (Supplementary Tables 1 & 2) ----------
  const indices = useMemo(() => {
    // Means across 0/30/60/90/120 for Matsuda
    const gMean = mean([ng0, ng30, ng60, ng90, ng120]);
    const iMean = mean([ni0, ni30, ni60, ni90, ni120]);

    // Table 1
    const homaIR = ng0 !== undefined && ni0 !== undefined ? safeDiv(ng0 * ni0, 405) : undefined;

    // BMI-dependent cutoffs for HOMA-IR (from table)
    const homaIRCutoff = (() => {
      if (hasMASLD) return 2;
      if (bmi !== undefined && bmi > 27.5) return 3.6;
      return 4.65;
    })();

    const matsuda = (() => {
      if (ng0 === undefined || ni0 === undefined || gMean === undefined || iMean === undefined) return undefined;
      const denom = sqrt((ng0 * ni0) * (gMean * iMean));
      if (!Number.isFinite(denom) || denom === 0) return undefined;
      return 10000 / denom;
    })();

    // Table 2
    const igi = (() => {
      // (I30 - I0) / (G30 - G0)
      if (ni30 === undefined || ni0 === undefined || ng30 === undefined || ng0 === undefined) return undefined;
      const denom = ng30 - ng0;
      if (denom === 0) return undefined;
      return (ni30 - ni0) / denom;
    })();

    // Stumvoll conversions
    const i0_pmol = ni0 === undefined ? undefined : ni0 * 6;
    const i30_pmol = ni30 === undefined ? undefined : ni30 * 6;
    const g30_mmol = ng30 === undefined ? undefined : ng30 / 18;

    const stumvoll1 = (() => {
      // 1283 + (1.829 × I30) – (138.7 × G30) + (3.772 × I0)
      if (i30_pmol === undefined || g30_mmol === undefined || i0_pmol === undefined) return undefined;
      return 1283 + 1.829 * i30_pmol - 138.7 * g30_mmol + 3.772 * i0_pmol;
    })();

    const stumvoll2 = (() => {
      // 287 + (0.4164 × I30) – (26.07 × G30) + (0.9226 × I0)
      if (i30_pmol === undefined || g30_mmol === undefined || i0_pmol === undefined) return undefined;
      return 287 + 0.4164 * i30_pmol - 26.07 * g30_mmol + 0.9226 * i0_pmol;
    })();

    const di = (() => {
      // DI = Matsuda × IGI
      if (matsuda === undefined || igi === undefined) return undefined;
      return matsuda * igi;
    })();

    const homaBeta = (() => {
      // (fasting insulin × 360) / (fasting glucose – 63)
      if (ni0 === undefined || ng0 === undefined) return undefined;
      const denom = ng0 - 63;
      if (denom === 0) return undefined;
      return (ni0 * 360) / denom;
    })();

    const pgAucWeighted = (() => {
      // (PG0 + 2×PG30 + 3×PG60 + 2×PG120) / 4
      if (ng0 === undefined || ng30 === undefined || ng60 === undefined || ng120 === undefined) return undefined;
      return (ng0 + 2 * ng30 + 3 * ng60 + 2 * ng120) / 4;
    })();

    return {
      gMean,
      iMean,
      homaIR,
      homaIRCutoff,
      matsuda,
      igi,
      stumvoll1,
      stumvoll2,
      di,
      homaBeta,
      pgAucWeighted,
    };
  }, [ng0, ng30, ng60, ng90, ng120, ni0, ni30, ni60, ni90, ni120, bmi, hasMASLD]);

  // ---------- STEP 3: High-risk prognostic markers (Figure 1) ----------
  const risk = useMemo(() => {
    const flags: Array<{ label: string; severity: "danger" | "warn" | "neutral"; exactRisk?: string }> = [];

    const IFG = isIFG(ng0);
    const IGT = isIGT(ng120);
    const oneHourHigh = ng60 !== undefined && ng60 > 155;
    const a1cHigh = nA1c !== undefined && nA1c >= 6.0 && nA1c <= 6.4;

    const igiLow = indices.igi !== undefined && indices.igi <= 0.82;
    const firstPhaseLow = indices.stumvoll1 !== undefined && indices.stumvoll1 <= 1007;

    const metS = metabolicSyndrome.present;

    // Rule blocks as written in Figure 1
    if (IGT && oneHourHigh && metS) {
      flags.push({ label: "IGT + 1-hour PG >155 mg/dL + metabolic syndrome", severity: "danger", exactRisk: "52.8%" });
    }

    if (IFG && IGT) {
      flags.push({ label: "Combined IFG and IGT", severity: "danger", exactRisk: ">50%" });
    }

    if (IFG && oneHourHigh && metS) {
      flags.push({ label: "IFG + 1-hour PG >155 mg/dL + metabolic syndrome", severity: "danger", exactRisk: "37.8%" });
    }

    if ((IGT || IFG) && oneHourHigh && a1cHigh) {
      flags.push({ label: "IGT or IFG + 1-hour PG >155 mg/dL + HbA1c 6.0–6.4%", severity: "danger" });
    }

    if ((IGT || IFG) && oneHourHigh && (igiLow || firstPhaseLow)) {
      flags.push({
        label: "IGT or IFG + 1-hour PG >155 mg/dL + IGI ≤0.82 and/or 1st-phase insulin secretion ≤1007 pmol/L",
        severity: "danger",
      });
    }

    // Additional transparent descriptive markers (not given as exact risk % in your figure)
    if (IFG) flags.push({ label: "IFG present (FPG 100–125 mg/dL)", severity: "warn" });
    if (IGT) flags.push({ label: "IGT present (2-hour PG 140–199 mg/dL)", severity: "warn" });
    if (oneHourHigh) flags.push({ label: "1-hour PG >155 mg/dL", severity: "warn" });
    if (metS) flags.push({ label: "Metabolic syndrome present (ATP III)", severity: "warn" });

    const highRisk = flags.some((f) => f.severity === "danger");

    // Provide a primary exact risk line if present
    const exactRisk = flags.find((f) => f.exactRisk)?.exactRisk;

    return {
      IFG,
      IGT,
      oneHourHigh,
      a1cHigh,
      igiLow,
      firstPhaseLow,
      metS,
      flags,
      highRisk,
      exactRisk,
    };
  }, [ng0, ng120, ng60, nA1c, indices.igi, indices.stumvoll1, metabolicSyndrome.present]);

  // ---------- STEP 4: Age-based eligibility + weight loss target ----------
  const step4 = useMemo(() => {
    if (!risk.highRisk) {
      return {
        applies: false,
        decision: "Not in high-risk group based on Step 3 criteria.",
        weightLoss: undefined as { lowKg: number; highKg: number } | undefined,
      };
    }
    if (nAge === undefined) {
      return {
        applies: true,
        decision: "High-risk group: enter age to determine eligibility recommendation.",
        weightLoss: undefined,
      };
    }

    let decision = "";
    if (nAge < 40) {
      decision = "Age <40 years: Not a candidate (high risk).";
    } else if (nAge >= 40 && nAge <= 49) {
      decision = "Age 40–49 years: Consider only if able to reverse high-risk prognostic markers with weight loss on repeat OGTT.";
    } else {
      decision = "Age ≥50 years: Can be accepted after risk mitigation with 5–10% weight loss.";
    }

    const wl = (() => {
      if (nWeight === undefined) return undefined;
      return { lowKg: nWeight * 0.05, highKg: nWeight * 0.10 };
    })();

    return { applies: true, decision, weightLoss: wl };
  }, [risk.highRisk, nAge, nWeight]);

    const saveBaseline = () => {
    const ts = new Date().toISOString();
    setBaseline({
      timestamp: ts,
      weightKg: nWeight,
      bmi,
      metsPresent: metabolicSyndrome.present,
      highRisk: risk.highRisk,
      exactRisk: risk.exactRisk,
      flags: risk.flags.map((f) => (f.exactRisk ? `${f.label} [${f.exactRisk}]` : f.label)),
      matsuda: indices.matsuda,
      homaIR: indices.homaIR,
      igi: indices.igi,
      stumvoll1: indices.stumvoll1,
      pgAuc: indices.pgAucWeighted,
    });
  };

  const comparison = useMemo(() => {
    if (!baseline) return null;

    const nowWeight = nWeight;
    const wlPct = baseline.weightKg !== undefined && nowWeight !== undefined && baseline.weightKg > 0
      ? ((baseline.weightKg - nowWeight) / baseline.weightKg) * 100
      : undefined;

    const reversedHighRisk = baseline.highRisk && !risk.highRisk;
    const newHighRisk = !baseline.highRisk && risk.highRisk;

    const baseFlags = new Set(baseline.flags);
    const nowFlags = new Set(risk.flags.map((f) => (f.exactRisk ? `${f.label} [${f.exactRisk}]` : f.label)));

    const added = Array.from(nowFlags).filter((x) => !baseFlags.has(x));
    const removed = Array.from(baseFlags).filter((x) => !nowFlags.has(x));

    return { wlPct, reversedHighRisk, newHighRisk, added, removed };
  }, [baseline, nWeight, risk.highRisk, risk.flags]);

  // ---------- Printable summary ----------
  const summary = useMemo(() => {
    const lines: string[] = [];
    lines.push(toolName);
    lines.push("—");
    if (nAge !== undefined) lines.push(`Age: ${nAge}`);
    if (sex) lines.push(`Sex: ${sex}`);
    if (ethnicity) lines.push(`Ethnicity: ${ethnicity}`);
    if (bmi !== undefined) lines.push(`BMI: ${fmt(bmi, 1)} kg/m²`);

    lines.push(" ");
    lines.push(`Step 1 (OGTT indication): ${ogttIndication.indicated ? "YES" : "NO"}`);
    if (ogttIndication.reasons.length) lines.push(`Reasons: ${ogttIndication.reasons.join("; ")}`);

    lines.push(" ");
    lines.push(`Step 2 (Metabolic syndrome): ${metabolicSyndrome.present ? "PRESENT" : "ABSENT/UNKNOWN"} (${metabolicSyndrome.metCount}/5 criteria met)`);

    lines.push(" ");
    lines.push(`Step 3 (High-risk prognostic markers): ${risk.highRisk ? "HIGH RISK" : "Not high-risk"}`);
    if (risk.exactRisk) lines.push(`Exact risk (per criteria): ${risk.exactRisk}`);
    if (risk.flags.length) lines.push(`Findings: ${risk.flags.map((f) => (f.exactRisk ? `${f.label} [${f.exactRisk}]` : f.label)).join("; ")}`);

    lines.push(" ");
    if (step4.applies) {
      lines.push(`Step 4 (Age-based recommendation): ${step4.decision}`);
      if (step4.weightLoss) {
        lines.push(`Weight-loss target (5–10%): ${fmt(step4.weightLoss.lowKg, 1)}–${fmt(step4.weightLoss.highKg, 1)} kg`);
      }
    }

    lines.push(" ");
    lines.push("Calculated indices:");
    lines.push(`- Matsuda index: ${fmt(indices.matsuda, 2)} (IR if <4.3)`);
    lines.push(`- HOMA-IR: ${fmt(indices.homaIR, 2)} (cutoff used: >${fmt(indices.homaIRCutoff, 2)})`);
    lines.push(`- IGI: ${fmt(indices.igi, 3)} (flag if ≤0.82 in Step 3 rule)`);
    lines.push(`- Stumvoll 1st-phase: ${fmt(indices.stumvoll1, 0)} pmol/L (flag if ≤1007)`);
    lines.push(`- Stumvoll 2nd-phase: ${fmt(indices.stumvoll2, 0)} pmol/L`);
    lines.push(`- Disposition index (Matsuda×IGI): ${fmt(indices.di, 3)}`);
    lines.push(`- HOMA-β: ${fmt(indices.homaBeta, 1)}`);
    lines.push(`- PG AUC (weighted): ${fmt(indices.pgAucWeighted, 1)} mg·h/dL`);

    lines.push(" ");
    lines.push("Disclaimer: Clinical decision support/education tool. No patient data are stored. Use clinical judgment.");

    return lines.join("\n");
  }, [toolName, nAge, sex, ethnicity, bmi, ogttIndication, metabolicSyndrome, risk, step4, indices]);

  const printPage = () => {
    // Parse summary into sections for nicer formatting
    const sections = summary.split("\n\n").map(section => {
      const lines = section.split("\n");
      return lines;
    });

    const printContent = `<!DOCTYPE html>
<html>
<head>
  <title>${toolName} - Summary</title>
  <meta charset="utf-8"/>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      padding: 50px;
      line-height: 1.5;
      color: #1e293b;
      max-width: 800px;
      margin: 0 auto;
      font-size: 11pt;
    }
    .header {
      border-bottom: 2px solid #e2e8f0;
      padding-bottom: 16px;
      margin-bottom: 24px;
    }
    h1 {
      font-size: 22pt;
      margin: 0 0 8px 0;
      color: #0f172a;
      font-weight: 600;
    }
    .timestamp {
      color: #64748b;
      font-size: 10pt;
    }
    .content {
      margin-bottom: 32px;
    }
    .section {
      margin-bottom: 20px;
      page-break-inside: avoid;
    }
    .section-title {
      font-weight: 600;
      color: #334155;
      font-size: 11pt;
      margin-bottom: 8px;
      padding-bottom: 4px;
      border-bottom: 1px solid #e2e8f0;
    }
    .section-content {
      color: #475569;
      font-size: 10pt;
    }
    .section-content p {
      margin: 4px 0;
    }
    .highlight {
      background-color: #fef3c7;
      padding: 2px 6px;
      border-radius: 4px;
      font-weight: 500;
    }
    .danger {
      color: #dc2626;
      font-weight: 600;
    }
    .warning {
      color: #d97706;
      font-weight: 500;
    }
    .ok {
      color: #059669;
    }
    ul {
      margin: 8px 0;
      padding-left: 20px;
    }
    li {
      margin: 4px 0;
      font-size: 10pt;
    }
    .footer {
      margin-top: 40px;
      padding-top: 16px;
      border-top: 1px solid #e2e8f0;
      font-size: 9pt;
      color: #64748b;
      display: flex;
      justify-content: space-between;
    }
    @media print {
      body { padding: 30px; }
      .section { page-break-inside: avoid; }
    }
    @page {
      margin: 0.75in;
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>${toolName}</h1>
    <div class="timestamp">Generated: ${new Date().toLocaleString()}</div>
  </div>
  <div class="content">
    <pre style="white-space: pre-wrap; font-family: inherit; font-size: 10pt; line-height: 1.6; margin: 0;">${summary.replace(/</g, "&lt;").replace(/HIGH RISK/g, '<span class="danger">HIGH RISK</span>').replace(/OGTT indicated/g, '<span class="warning">OGTT indicated</span>').replace(/Metabolic syndrome present/g, '<span class="warning">Metabolic syndrome present</span>')}</pre>
  </div>
  <div class="footer">
    <span>Clinical decision support tool - No patient data stored</span>
    <span>${toolName}</span>
  </div>
</body>
</html>`;

    const printWindow = window.open("", "_blank");
    if (!printWindow) {
      alert("Please allow popups to print the summary.");
      return;
    }
    printWindow.document.open();
    printWindow.document.write(printContent);
    printWindow.document.close();
    printWindow.onload = () => {
      printWindow.print();
    };
  };

  const exportPDF = async () => {
    // PDF export of the text summary (no PHI stored). Requires: npm i jspdf
    try {
      const mod = await import("jspdf");
      // @ts-ignore
      const jsPDF = (mod as any).jsPDF || (mod as any).default;
      const doc = new jsPDF({ unit: "pt", format: "letter" });
      const margin = 50;
      const pageW = doc.internal.pageSize.getWidth();
      const pageH = doc.internal.pageSize.getHeight();
      const maxW = pageW - margin * 2;

      // Sanitize text for PDF (replace Unicode with ASCII equivalents)
      const sanitizeForPDF = (text: string): string => {
        return text
          .replace(/—/g, "-")           // em dash
          .replace(/–/g, "-")           // en dash
          .replace(/²/g, "2")           // superscript 2
          .replace(/≤/g, "<=")          // less than or equal
          .replace(/≥/g, ">=")          // greater than or equal
          .replace(/×/g, "x")           // multiplication sign
          .replace(/·/g, ".")           // middle dot
          .replace(/β/g, "beta")        // Greek beta
          .replace(/μ/g, "u")           // Greek mu
          .replace(/°/g, " degrees")    // degree symbol
          .replace(/±/g, "+/-")         // plus minus
          .replace(/→/g, "->")          // arrow
          .replace(/←/g, "<-")          // arrow
          .replace(/\u2013/g, "-")      // en dash unicode
          .replace(/\u2014/g, "-")      // em dash unicode
          .replace(/\u00B2/g, "2")      // superscript 2 unicode
          .replace(/[^\x00-\x7F]/g, ""); // remove any remaining non-ASCII
      };

      const cleanSummary = sanitizeForPDF(summary);

      // Title
      doc.setFont("helvetica", "bold");
      doc.setFontSize(18);
      doc.setTextColor(15, 23, 42);
      doc.text("OGTT-DM Risk Stratifier", margin, margin + 20);

      // Timestamp
      doc.setFont("helvetica", "normal");
      doc.setFontSize(10);
      doc.setTextColor(100, 116, 139);
      doc.text("Generated: " + new Date().toLocaleString(), margin, margin + 38);

      // Divider line
      doc.setDrawColor(226, 232, 240);
      doc.line(margin, margin + 48, pageW - margin, margin + 48);

      // Content
      doc.setFont("helvetica", "normal");
      doc.setFontSize(10);
      doc.setTextColor(30, 41, 59);

      const lines = doc.splitTextToSize(cleanSummary, maxW);
      const lineH = 14;

      let y = margin + 70;
      for (let i = 0; i < lines.length; i++) {
        if (y + lineH > pageH - margin - 30) {
          doc.addPage();
          y = margin;
        }
        doc.text(lines[i], margin, y);
        y += lineH;
      }

      // Footer on each page
      const pageCount = doc.getNumberOfPages();
      for (let p = 1; p <= pageCount; p++) {
        doc.setPage(p);
        doc.setFontSize(9);
        doc.setTextColor(100, 116, 139);
        doc.text(
          "Clinical decision support tool - No patient data stored",
          margin,
          pageH - 30
        );
        doc.text("Page " + p + " of " + pageCount, pageW - margin - 50, pageH - 30);
      }

      doc.save("OGTT-DM-Risk-Stratifier-summary.pdf");
    } catch (e) {
      console.error("PDF export error:", e);
      alert("PDF export failed. Please try again.");
    }
  };

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="mx-auto max-w-6xl px-4 py-8">
        <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
          <div>
            <div className="text-2xl font-semibold text-slate-900">{toolName}</div>
            <div className="mt-1 text-sm text-slate-600">
              Stepwise risk stratification integrating OGTT-based markers and ATP III metabolic syndrome criteria. No data are stored.
            </div>
          </div>
          <div className="flex gap-2 flex-wrap">
            <button
              onClick={() => navigator.clipboard.writeText(summary)}
              className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-800 shadow-sm hover:bg-slate-50"
            >
              Copy summary
            </button>
            <button
              onClick={printPage}
              className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-800 shadow-sm hover:bg-slate-50"
            >
              Print
            </button>
            <button
              onClick={exportPDF}
              className="rounded-xl bg-slate-900 px-3 py-2 text-sm font-medium text-white shadow-sm hover:bg-slate-800"
            >
              Export PDF
            </button>
            <button
              onClick={saveBaseline}
              className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-800 shadow-sm hover:bg-slate-50"
            >
              Save as baseline
            </button>
            {baseline ? (
              <button
                onClick={clearBaseline}
                className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-800 shadow-sm hover:bg-slate-50"
              >
                Clear baseline
              </button>
            ) : null}
          </div>
        </div>

        <div className="mt-6 grid grid-cols-1 gap-5 lg:grid-cols-2">
          <Section title="Patient factors" subtitle="Baseline variables used for OGTT indication and metabolic syndrome">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <Field label="Age" value={age} onChange={setAge} unit="years" min={10} max={100} />
              <div className="space-y-1">
                <label className="text-sm font-medium text-slate-800">Sex</label>
                <select
                  className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-slate-200"
                  value={sex}
                  onChange={(e) => setSex(e.target.value as any)}
                >
                  <option value="">Select…</option>
                  <option value="female">Female</option>
                  <option value="male">Male</option>
                </select>
              </div>

              <div className="space-y-1 md:col-span-2">
                <label className="text-sm font-medium text-slate-800">Ethnicity</label>
                <select
                  className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-slate-200"
                  value={ethnicity}
                  onChange={(e) => setEthnicity(e.target.value as any)}
                >
                  <option value="">Select…</option>
                  <option value="African American">African American</option>
                  <option value="Hispanic/Latino">Hispanic/Latino</option>
                  <option value="Native American">Native American</option>
                  <option value="Asian American">Asian American</option>
                  <option value="White">White</option>
                  <option value="Other">Other</option>
                </select>
                <div className="text-xs text-slate-500">Asian Americans use BMI threshold ≥23 kg/m² for OGTT indication step.</div>
              </div>

              <Field label="Weight" value={weightKg} onChange={setWeightKg} unit="kg" min={20} max={300} />
              <Field label="Height" value={heightCm} onChange={setHeightCm} unit="cm" min={100} max={230} />

              <div className="md:col-span-2 flex items-center justify-between rounded-xl border border-slate-200 px-3 py-2">
                <div className="text-sm text-slate-700">BMI</div>
                <div className="text-sm font-semibold text-slate-900">{bmi === undefined ? "—" : `${fmt(bmi, 1)} kg/m²`}</div>
              </div>

              <Field label="Waist circumference" value={waistCm} onChange={setWaistCm} unit="cm" min={40} max={200} />
              <Field label="Triglycerides" value={tg} onChange={setTg} unit="mg/dL" min={20} max={2000} />
              <Field label="HDL" value={hdl} onChange={setHdl} unit="mg/dL" min={5} max={200} />
              <Field label="Systolic BP" value={sbp} onChange={setSbp} unit="mm Hg" min={60} max={260} />
              <Field label="Diastolic BP" value={dbp} onChange={setDbp} unit="mm Hg" min={30} max={160} />
              <Field label="HbA1c" value={a1c} onChange={setA1c} unit="%" min={3.5} max={15} step="0.1" />
            </div>

            <div className="mt-4 grid grid-cols-1 gap-2 md:grid-cols-2">
              <Toggle label="On antihypertensive treatment" checked={onBPtx} onChange={setOnBPtx} />
              <Toggle label="History of gestational diabetes" checked={hxGDM} onChange={setHxGDM} />
              <Toggle label="History of pancreatitis" checked={hxPancreatitis} onChange={setHxPancreatitis} />
              <Toggle label="MASLD" checked={hasMASLD} onChange={setHasMASLD} hint="Also affects HOMA-IR cutoff per your table." />
              <Toggle label="PCOS" checked={hasPCOS} onChange={setHasPCOS} />
              <Toggle label="First-degree relative with T2D" checked={fhxT2D} onChange={setFhxT2D} />
            </div>
          </Section>

          <Section title="OGTT inputs" subtitle="Glucose (mg/dL) and insulin (mU/L) at 0, 30, 60, 90, 120 minutes">
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <div className="rounded-2xl border border-slate-200 p-4">
                <div className="text-sm font-semibold text-slate-900 mb-3">Glucose (mg/dL)</div>
                <div className="flex flex-col gap-3">
                  <Field label="0 min" value={g0} onChange={setG0} />
                  <Field label="30 min" value={g30} onChange={setG30} />
                  <Field label="60 min" value={g60} onChange={setG60} />
                  <Field label="90 min" value={g90} onChange={setG90} />
                  <Field label="120 min" value={g120} onChange={setG120} />
                </div>
              </div>

              <div className="rounded-2xl border border-slate-200 p-4">
                <div className="text-sm font-semibold text-slate-900 mb-3">Insulin (mU/L)</div>
                <div className="flex flex-col gap-3">
                  <Field label="0 min" value={i0} onChange={setI0} />
                  <Field label="30 min" value={i30} onChange={setI30} />
                  <Field label="60 min" value={i60} onChange={setI60} />
                  <Field label="90 min" value={i90} onChange={setI90} />
                  <Field label="120 min" value={i120} onChange={setI120} />
                </div>
                <div className="mt-3 text-xs text-slate-500">
                  Stumvoll equations use insulin in pmol/L (×6) and glucose in mmol/L (mg/dL ÷18).
                </div>
              </div>
            </div>
          </Section>

          <Section title="Step 1: Who should undergo OGTT?" subtitle="Implements the Figure 1 Step 1 triggers">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={ogttIndication.indicated ? "warn" : "ok"}>{ogttIndication.indicated ? "OGTT indicated" : "OGTT not indicated"}</Badge>
              {isAsian ? <Badge tone="neutral">Asian BMI threshold ≥23</Badge> : <Badge tone="neutral">BMI threshold ≥25</Badge>}
              {highRiskEthnicity ? <Badge tone="neutral">High-risk ethnicity</Badge> : null}
            </div>
            <div className="mt-3 rounded-xl bg-slate-50 p-3">
              <div className="text-sm font-medium text-slate-800">Reasons</div>
              {ogttIndication.reasons.length ? (
                <ul className="mt-2 list-disc pl-5 text-sm text-slate-700">
                  {ogttIndication.reasons.map((r, idx) => (
                    <li key={idx}>{r}</li>
                  ))}
                </ul>
              ) : (
                <div className="mt-2 text-sm text-slate-600">No Step 1 indication criteria met based on current inputs.</div>
              )}
            </div>
          </Section>

          <Section title="Step 2: Metabolic syndrome (ATP III)" subtitle="Metabolic syndrome present if ≥3 criteria met">
            <div className="flex items-center gap-2">
              <Badge tone={metabolicSyndrome.present ? "warn" : "ok"}>
                {metabolicSyndrome.present ? "Metabolic syndrome present" : "Metabolic syndrome not present / incomplete"}
              </Badge>
              <div className="text-sm text-slate-700">{metabolicSyndrome.metCount}/5 criteria met</div>
            </div>

            <div className="mt-3 divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white">
              {metabolicSyndrome.criteria.map((c, idx) => (
                <div key={idx} className="px-3 py-2 flex items-center justify-between">
                  <div className="text-sm text-slate-800">{c.name}</div>
                  <div className="flex items-center gap-2">
                    {c.detail ? <span className="text-xs text-slate-500">{c.detail}</span> : null}
                    <Badge tone={c.met ? "warn" : "neutral"}>{c.met ? "Met" : "Not met"}</Badge>
                  </div>
                </div>
              ))}
            </div>
          </Section>

          <Section title="Step 3: OGTT-based prognostic markers" subtitle="High-risk markers and derived indices (Tables 1–2)">
            <div className="mb-3 flex flex-wrap gap-2">
              <Badge tone={isIFG(ng0) ? "warn" : "neutral"}>IFG: {isIFG(ng0) ? "Yes" : "No"}</Badge>
              <Badge tone={isIGT(ng120) ? "warn" : "neutral"}>IGT: {isIGT(ng120) ? "Yes" : "No"}</Badge>
              <Badge tone={ng60 !== undefined && ng60 > 155 ? "warn" : "neutral"}>1-h PG &gt;155: {ng60 !== undefined && ng60 > 155 ? "Yes" : "No"}</Badge>
              <Badge tone={metabolicSyndrome.present ? "warn" : "neutral"}>MetS: {metabolicSyndrome.present ? "Yes" : "No/Incomplete"}</Badge>
              <Badge tone={nA1c !== undefined && nA1c >= 6.0 && nA1c <= 6.4 ? "warn" : "neutral"}>A1c 6.0–6.4: {nA1c !== undefined && nA1c >= 6.0 && nA1c <= 6.4 ? "Yes" : "No/NA"}</Badge>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={risk.highRisk ? "danger" : "ok"}>{risk.highRisk ? "HIGH RISK" : "Not high-risk (per criteria)"}</Badge>
              {risk.exactRisk ? <Badge tone="danger">Exact risk: {risk.exactRisk}</Badge> : null}
            </div>

            <div className="mt-3 rounded-xl border border-slate-200 bg-white p-4">
              <div className="text-sm font-semibold text-slate-900">Triggered findings</div>
              {risk.flags.length ? (
                <ul className="mt-2 list-disc pl-5 text-sm text-slate-700">
                  {risk.flags.map((f, idx) => (
                    <li key={idx}>
                      <span className="font-medium">{f.label}</span>
                      {f.exactRisk ? <span className="text-slate-600"> — risk: {f.exactRisk}</span> : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="mt-2 text-sm text-slate-600">No Step 3 markers triggered based on current inputs.</div>
              )}
            </div>

            <div className="mt-4 rounded-2xl border border-slate-200 bg-white">
              <div className="border-b border-slate-100 px-4 py-3">
                <div className="text-sm font-semibold text-slate-900">Calculated indices</div>
                <div className="mt-1 text-xs text-slate-500">Computed automatically when required timepoints are provided.</div>
              </div>
              <div className="divide-y divide-slate-100 px-4">
                <ListItem k="Matsuda index" v={<span>{fmt(indices.matsuda, 2)} {indices.matsuda !== undefined ? <span className="ml-2"><Badge tone={indices.matsuda < 4.3 ? "warn" : "ok"}>{indices.matsuda < 4.3 ? "IR (<4.3)" : "≥4.3"}</Badge></span> : null}</span>} />
                <ListItem
                  k="HOMA-IR"
                  v={
                    <span>
                      {fmt(indices.homaIR, 2)}
                      {indices.homaIR !== undefined ? (
                        <span className="ml-2">
                          <Badge tone={indices.homaIR > indices.homaIRCutoff ? "warn" : "ok"}>
                            {indices.homaIR > indices.homaIRCutoff ? `IR (>${fmt(indices.homaIRCutoff, 2)})` : `≤${fmt(indices.homaIRCutoff, 2)}`}
                          </Badge>
                        </span>
                      ) : null}
                    </span>
                  }
                />
                <ListItem k="Insulinogenic index (IGI)" v={<span>{fmt(indices.igi, 3)} {indices.igi !== undefined ? <span className="ml-2"><Badge tone={indices.igi <= 0.82 ? "warn" : "ok"}>{indices.igi <= 0.82 ? "≤0.82" : ">0.82"}</Badge></span> : null}</span>} />
                <ListItem k="Stumvoll 1st-phase" v={<span>{fmt(indices.stumvoll1, 0)} pmol/L {indices.stumvoll1 !== undefined ? <span className="ml-2"><Badge tone={indices.stumvoll1 <= 1007 ? "warn" : "ok"}>{indices.stumvoll1 <= 1007 ? "≤1007" : ">1007"}</Badge></span> : null}</span>} />
                <ListItem k="Stumvoll 2nd-phase" v={<span>{fmt(indices.stumvoll2, 0)} pmol/L</span>} />
                <ListItem k="Disposition index (Matsuda×IGI)" v={<span>{fmt(indices.di, 3)}</span>} />
                <ListItem k="HOMA-β" v={<span>{fmt(indices.homaBeta, 1)}</span>} />
                <ListItem k="PG AUC (weighted)" v={<span>{fmt(indices.pgAucWeighted, 1)} mg·h/dL</span>} />
              </div>
            </div>
          </Section>

          <Section title="Step 4: Age-based recommendation + weight loss" subtitle="Applies only to high-risk group (Figure 1)">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={step4.applies ? (risk.highRisk ? "danger" : "neutral") : "neutral"}>{step4.applies ? "Applies" : "Not applicable"}</Badge>
              {step4.weightLoss ? <Badge tone="warn">Target: 5–10% weight loss</Badge> : null}
            </div>

            <div className="mt-3 rounded-xl bg-slate-50 p-4">
              <div className="text-sm font-semibold text-slate-900">Recommendation</div>
              <div className="mt-1 text-sm text-slate-700">{step4.decision}</div>
              {step4.weightLoss ? (
                <div className="mt-3 text-sm text-slate-800">
                  Weight-loss target (5–10%): <span className="font-semibold">{fmt(step4.weightLoss.lowKg, 1)}–{fmt(step4.weightLoss.highKg, 1)} kg</span>
                </div>
              ) : null}
              <div className="mt-3 text-xs text-slate-500">
                This mirrors Figure 1 recommendations for high-risk donor candidates; interpret within full clinical context.
              </div>
            </div>
          </Section>
        </div>

        {baseline ? (
          <div className="mt-6 rounded-2xl border border-slate-200 bg-white p-5">
            <div className="flex flex-col gap-1 md:flex-row md:items-center md:justify-between">
              <div>
                <div className="text-base font-semibold text-slate-900">Baseline vs repeat comparison</div>
                <div className="text-sm text-slate-600">Baseline saved at {baseline.timestamp}</div>
              </div>
              <div className="flex flex-wrap gap-2">
                {comparison?.reversedHighRisk ? <Badge tone="ok">High-risk markers reversed</Badge> : null}
                {comparison?.newHighRisk ? <Badge tone="danger">New high-risk markers present</Badge> : null}
                {comparison?.wlPct !== undefined ? (
                  <Badge tone={comparison.wlPct >= 5 ? "ok" : "warn"}>Weight change: {comparison.wlPct.toFixed(1)}%</Badge>
                ) : (
                  <Badge tone="neutral">Weight change: —</Badge>
                )}
              </div>
            </div>

            <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
              <div className="rounded-xl border border-slate-200 p-4">
                <div className="text-sm font-semibold text-slate-900">Baseline snapshot</div>
                <div className="mt-2 text-sm text-slate-700">High-risk: <span className="font-semibold">{baseline.highRisk ? "Yes" : "No"}</span>{baseline.exactRisk ? ` (exact: ${baseline.exactRisk})` : ""}</div>
                <div className="mt-2 text-sm text-slate-700">Metabolic syndrome: <span className="font-semibold">{baseline.metsPresent ? "Yes" : "No"}</span></div>
                <div className="mt-2 text-sm text-slate-700">BMI: <span className="font-semibold">{baseline.bmi === undefined ? "—" : baseline.bmi.toFixed(1)}</span></div>
                <div className="mt-2 text-sm text-slate-700">Matsuda: <span className="font-semibold">{baseline.matsuda === undefined ? "—" : baseline.matsuda.toFixed(2)}</span></div>
                <div className="mt-2 text-sm text-slate-700">HOMA-IR: <span className="font-semibold">{baseline.homaIR === undefined ? "—" : baseline.homaIR.toFixed(2)}</span></div>
                <div className="mt-3 text-xs text-slate-500">Flags: {baseline.flags.length ? baseline.flags.join("; ") : "None"}</div>
              </div>

              <div className="rounded-xl border border-slate-200 p-4">
                <div className="text-sm font-semibold text-slate-900">Changes</div>
                <div className="mt-2 text-sm text-slate-700">Added flags: <span className="font-semibold">{comparison?.added?.length ? comparison.added.join("; ") : "None"}</span></div>
                <div className="mt-2 text-sm text-slate-700">Resolved flags: <span className="font-semibold">{comparison?.removed?.length ? comparison.removed.join("; ") : "None"}</span></div>
                <div className="mt-3 text-xs text-slate-500">Use: Save baseline before weight loss; then enter repeat OGTT values to assess reversal of high-risk markers (Figure 1 Step 4).</div>
              </div>
            </div>
          </div>
        ) : null}

        <div className="mt-6 rounded-2xl border border-slate-200 bg-white p-5">
          <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
            <div>
              <div className="text-base font-semibold text-slate-900">Clinical summary</div>
              <div className="text-sm text-slate-600">Copy into a note or print. No identifiers included.</div>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => navigator.clipboard.writeText(summary)}
                className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-800 shadow-sm hover:bg-slate-50"
              >
                Copy
              </button>
              <button onClick={printPage} className="rounded-xl bg-slate-900 px-3 py-2 text-sm font-medium text-white shadow-sm hover:bg-slate-800">
                Print
              </button>
            </div>
          </div>
          <pre className="mt-3 whitespace-pre-wrap rounded-xl bg-slate-50 p-4 text-xs text-slate-800">{summary}</pre>
        </div>

        <div className="mt-6 text-xs text-slate-500">
          Disclaimer: This clinician-facing calculator is for educational/decision support use only and is not a substitute for clinical judgment.
          It stores no data and performs all calculations locally in the browser.
        </div>
      </div>
    </div>
  );
}
