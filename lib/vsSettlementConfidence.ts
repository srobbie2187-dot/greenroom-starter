/**
 * Vs deal — settlement confidence / explainability layer.
 *
 * NOT a replacement for the in-app calculator (`calculateSettlement` still
 * returns unsupported for Vs). This module:
 *   - Parses `dealNotesFreetext` with deterministic rules
 *   - Produces an illustrative payout walkthrough and mismatch flags
 *
 * Parser entry point is named and typed so a future `parseVsDealNotesLLM`
 * can return the same `VsParsedDealTerms` shape without changing callers.
 */

import type { Deal, Expense, Settlement, TicketSale, Recoup } from "@/db/schema";

// ---------------------------------------------------------------------------
// Types (stable contract for a future LLM-backed parser)
// ---------------------------------------------------------------------------

export type VsDealVariantFlag =
  | "walkout_pot"
  | "tier_ratchet_or_escalator"
  | "percent_of_gross_basis_in_notes"
  | "bonuses_mentioned_in_prose_only";

/** Output of parsing deal prose — replace implementation, keep shape. */
export interface VsParsedDealTerms {
  parserId: "deterministic_regex_v1";
  /** Where numeric fields came from for UI transparency */
  fieldSources: Partial<
    Record<
      | "guarantee"
      | "percentage"
      | "expenseCap"
      | "hospitalityCap"
      | "percentageBasis",
      "notes" | "structured" | "notes_and_structured_agree"
    >
  >;
  guarantee: number | null;
  /** Artist share 0–1 (e.g. 0.85 for 85%). */
  percentage: number | null;
  percentageBasis: "gross" | "net_after_effective_expenses" | null;
  expenseCap: number | null;
  hospitalityCap: number | null;
  variantFlags: VsDealVariantFlag[];
  /** Could not read from notes; filled from structured deal where possible */
  extractionGaps: string[];
}

export interface VsConfidenceStep {
  label: string;
  value: number | null;
  note?: string;
}

export interface VsConfidenceWarning {
  severity: "info" | "warning";
  title: string;
  detail: string;
}

export interface VsSettlementConfidence {
  /** Product copy — reminds operator this is guidance, not authoritative */
  positioningBlurb: string;
  parsed: VsParsedDealTerms;
  steps: VsConfidenceStep[];
  /** Standard Vs “max(guarantee, %)” when we’re not blocked by variant flags */
  illustrativeTotalToArtist: number | null;
  illustrativeExplanation: string;
  warnings: VsConfidenceWarning[];
  /** Short script Mariana can adapt on a call */
  tourManagerScript: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Deterministic parser. A future LLM parser should return `VsParsedDealTerms`
 * with `parserId` updated (e.g. `llm_v1`) — consumers should not branch on id.
 */
export function parseVsDealNotesDeterministic(
  dealNotesFreetext: string | null | undefined,
  structured: Deal,
): VsParsedDealTerms {
  const text = (dealNotesFreetext ?? "").trim();
  const lower = text.toLowerCase();

  const variantFlags: VsDealVariantFlag[] = [];
  if (/\bwalkout\b/i.test(text)) variantFlags.push("walkout_pot");
  if (
    /\bratchet\b|\bescalat/i.test(text) ||
    /\d+\s*%\s*net\s*to\b/i.test(text) ||
    /\bover\s+\d+%\s*(capacity|sold)/i.test(text)
  ) {
    variantFlags.push("tier_ratchet_or_escalator");
  }
  if (
    /% of gross|\bvs\b[^.]*\bgross\b|no expense deductions/i.test(lower)
  ) {
    variantFlags.push("percent_of_gross_basis_in_notes");
  }
  if (
    /\bbonus(es)?\b/i.test(text) &&
    !structured.bonusesJson &&
    !/%\s*of gross/i.test(lower) // avoid double-flagging vs_gross phrasing
  ) {
    variantFlags.push("bonuses_mentioned_in_prose_only");
  }

  const extractionGaps: string[] = [];
  const fieldSources: VsParsedDealTerms["fieldSources"] = {};

  const fromNotes = extractVsNumbersFromNotes(text);

  let guarantee = fromNotes.guarantee ?? null;
  if (guarantee != null) fieldSources.guarantee = "notes";
  if (guarantee == null && structured.guaranteeAmount != null) {
    guarantee = structured.guaranteeAmount;
    fieldSources.guarantee = "structured";
    extractionGaps.push("Guarantee not detected in notes — using structured field.");
  } else if (guarantee == null) {
    extractionGaps.push("No guarantee found in notes or structured fields.");
  }

  let percentage = fromNotes.percentage ?? null;
  if (percentage != null) fieldSources.percentage = "notes";
  if (percentage == null && structured.percentage != null) {
    percentage = structured.percentage;
    fieldSources.percentage = "structured";
    extractionGaps.push("Percentage not detected in notes — using structured field.");
  } else if (percentage == null) {
    extractionGaps.push("No artist percentage found in notes or structured fields.");
  }

  let percentageBasis: VsParsedDealTerms["percentageBasis"] =
    fromNotes.percentageBasis ??
    (structured.percentageBasis === "gross"
      ? "gross"
      : structured.percentageBasis === "net"
        ? "net_after_effective_expenses"
        : null);

  if (fromNotes.percentageBasis) fieldSources.percentageBasis = "notes";
  else if (structured.percentageBasis)
    fieldSources.percentageBasis = "structured";

  if (variantFlags.includes("percent_of_gross_basis_in_notes")) {
    percentageBasis = "gross";
    fieldSources.percentageBasis = "notes";
  }

  let expenseCap = fromNotes.expenseCap ?? null;
  if (fromNotes.expenseCap != null) fieldSources.expenseCap = "notes";
  if (expenseCap == null && structured.expenseCap != null) {
    expenseCap = structured.expenseCap;
    fieldSources.expenseCap = "structured";
  }

  let hospitalityCap = fromNotes.hospitalityCap ?? null;
  if (fromNotes.hospitalityCap != null)
    fieldSources.hospitalityCap = "notes";
  if (hospitalityCap == null && structured.hospitalityCap != null) {
    hospitalityCap = structured.hospitalityCap;
    fieldSources.hospitalityCap = "structured";
  }

  // Mark agreement when both present and close
  if (
    fromNotes.guarantee != null &&
    structured.guaranteeAmount != null &&
    Math.abs(fromNotes.guarantee - structured.guaranteeAmount) < 1
  ) {
    fieldSources.guarantee = "notes_and_structured_agree";
  }
  if (
    fromNotes.percentage != null &&
    structured.percentage != null &&
    Math.abs(fromNotes.percentage - structured.percentage) < 0.001
  ) {
    fieldSources.percentage = "notes_and_structured_agree";
  }

  return {
    parserId: "deterministic_regex_v1",
    fieldSources,
    guarantee,
    percentage,
    percentageBasis,
    expenseCap,
    hospitalityCap,
    variantFlags,
    extractionGaps,
  };
}

export interface VsConfidenceInput {
  deal: Deal;
  ticketSales: TicketSale[];
  expenses: Expense[];
  settlement: Settlement | null;
  recoups: Recoup[];
}

export function buildVsSettlementConfidence(
  input: VsConfidenceInput,
): VsSettlementConfidence {
  const { deal, ticketSales, expenses, settlement, recoups } = input;

  const parsed = parseVsDealNotesDeterministic(deal.dealNotesFreetext, deal);

  const grossBoxOffice = ticketSales.reduce((s, t) => s + t.gross, 0);
  const totalFees = ticketSales.reduce((s, t) => s + t.fees, 0);
  const netBoxOffice = grossBoxOffice - totalFees;
  const passedThroughExpenses = expenses
    .filter((e) => !e.absorbedByVenue)
    .reduce((s, e) => s + e.amount, 0);

  const expenseCap = parsed.expenseCap;
  const effectiveExpenses =
    expenseCap != null
      ? Math.min(passedThroughExpenses, expenseCap)
      : passedThroughExpenses;

  const notesGuarantee = extractVsNumbersFromNotes(
    (deal.dealNotesFreetext ?? "").trim(),
  ).guarantee;
  const notesPct = extractVsNumbersFromNotes(
    (deal.dealNotesFreetext ?? "").trim(),
  ).percentage;

  const steps: VsConfidenceStep[] = [
    { label: "Gross box office (ticket sales)", value: grossBoxOffice },
    { label: "Less: fees", value: -totalFees, note: "From ticket sales rows" },
    { label: "Net box office", value: netBoxOffice },
    {
      label: "Passed-through expenses (as entered)",
      value: passedThroughExpenses,
      note: "Excludes items marked absorbed by venue",
    },
  ];

  if (expenseCap != null) {
    steps.push({
      label: "Expense cap (from parsed / structured deal)",
      value: expenseCap,
      note:
        passedThroughExpenses > expenseCap
          ? `Capping for % path: ${effectiveExpenses.toFixed(2)} counted toward net`
          : "Actual expenses are under the cap — no capping applied",
    });
  }

  let netForPercentPath: number | null = null;
  if (parsed.percentageBasis === "gross") {
    netForPercentPath = grossBoxOffice;
    steps.push({
      label: "Basis for % path",
      value: netForPercentPath,
      note: "Notes suggest % of gross — expenses are not deducted for this path",
    });
  } else if (parsed.percentageBasis === "net_after_effective_expenses") {
    netForPercentPath = netBoxOffice - effectiveExpenses;
    steps.push({
      label: "Net after effective expenses (% path basis)",
      value: netForPercentPath,
    });
  } else {
    netForPercentPath = netBoxOffice - effectiveExpenses;
    steps.push({
      label: "Net after expenses (assumed % path — basis not explicit)",
      value: netForPercentPath,
      note: "Defaulting to net after expenses; confirm against the deal email",
    });
  }

  const pct = parsed.percentage;
  const guarantee = parsed.guarantee;

  let percentPathPayout: number | null = null;
  if (pct != null && netForPercentPath != null) {
    percentPathPayout = netForPercentPath * pct;
    const pctLabel =
      parsed.percentageBasis === "gross"
        ? `% of gross (${(pct * 100).toFixed(1)}%)`
        : `% share of net basis (${(pct * 100).toFixed(1)}%)`;
    steps.push({
      label: pctLabel,
      value: percentPathPayout,
    });
  }

  let guaranteeStep: number | null = null;
  if (guarantee != null) {
    guaranteeStep = guarantee;
    steps.push({
      label: "Guarantee (floor)",
      value: guaranteeStep,
    });
  }

  const variantBlocksIllustrative =
    parsed.variantFlags.includes("walkout_pot") ||
    parsed.variantFlags.includes("tier_ratchet_or_escalator");

  let illustrativeTotalToArtist: number | null = null;
  let illustrativeExplanation = "";

  if (variantBlocksIllustrative) {
    illustrativeExplanation =
      "This deal mentions a walkout arrangement and/or a ratchet/escalator. Those structures change who earns incremental dollars — a simple max(guarantee, %) illustration could mislead, so we are not showing a single estimated payout.";
  } else if (guarantee != null && percentPathPayout != null) {
    illustrativeTotalToArtist = Math.max(guarantee, percentPathPayout);
    const winner =
      guarantee >= percentPathPayout ? "guarantee" : "percentage path";
    illustrativeExplanation = `Illustrative standard Vs: greater of guarantee (${money(guarantee)}) and % path (${money(percentPathPayout)}) → ${money(illustrativeTotalToArtist)} (${winner} wins). Not a final settlement — bonuses, recoups, comps, and hospitality treatment can change the number.`;
    steps.push({
      label: "Greater of guarantee vs % path (illustrative)",
      value: illustrativeTotalToArtist,
      note: "Does not include recoup deductions or prose-only bonuses",
    });
  } else if (guarantee != null) {
    illustrativeTotalToArtist = guarantee;
    illustrativeExplanation =
      "Only the guarantee could be read confidently — % path is incomplete. Treat any logged total with extra scrutiny.";
    steps.push({
      label: "Illustrative total (guarantee only)",
      value: illustrativeTotalToArtist,
      note: "Percentage path missing — incomplete parse",
    });
  } else if (percentPathPayout != null) {
    illustrativeTotalToArtist = percentPathPayout;
    illustrativeExplanation =
      "Only the % path could be read confidently — guarantee is missing from notes/structured fields.";
    steps.push({
      label: "Illustrative total (% path only)",
      value: illustrativeTotalToArtist,
      note: "Guarantee missing — incomplete parse",
    });
  } else {
    illustrativeExplanation =
      "Could not build an illustrative total — key terms are missing.";
  }

  if (parsed.hospitalityCap != null) {
    steps.push({
      label: "Hospitality cap (context)",
      value: parsed.hospitalityCap,
      note: "Verify how hospitality was booked against this cap — not auto-applied here",
    });
  }

  const warnings = buildWarnings({
    parsed,
    structured: deal,
    notesGuarantee,
    notesPct,
    grossBoxOffice,
    netBoxOffice,
    passedThroughExpenses,
    settlement,
    recoups,
    illustrativeTotalToArtist,
    percentPathPayout,
    guarantee,
  });

  const positioningBlurb =
    "This is a confidence layer — not Greenroom’s calculator and not a promise of the final payout. It reads the deal prose, walks through a simple Vs shape, and surfaces where notes, structured fields, or the logged settlement disagree.";

  const tourManagerScript = buildTourManagerScript({
    parsed,
    grossBoxOffice,
    netBoxOffice,
    passedThroughExpenses,
    effectiveExpenses,
    illustrativeTotalToArtist,
    guarantee,
    percentPathPayout,
    settlementTotal: settlement?.totalToArtist ?? null,
    variantBlocksIllustrative,
    recoupDisputed: recoups.some((r) => r.status === "disputed"),
  });

  return {
    positioningBlurb,
    parsed,
    steps,
    illustrativeTotalToArtist,
    illustrativeExplanation,
    warnings,
    tourManagerScript,
  };
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

function money(n: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(n);
}

interface ExtractedNums {
  guarantee: number | null;
  percentage: number | null;
  percentageBasis: "gross" | "net_after_effective_expenses" | null;
  expenseCap: number | null;
  hospitalityCap: number | null;
}

function parseMoneyChunk(raw: string): number | null {
  const n = Number.parseFloat(raw.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** Extraction tuned to `generateVsDealNotes` patterns in db/seed.ts */
function extractVsNumbersFromNotes(text: string): ExtractedNums {
  if (!text) {
    return {
      guarantee: null,
      percentage: null,
      percentageBasis: null,
      expenseCap: null,
      hospitalityCap: null,
    };
  }

  const lower = text.toLowerCase();

  let guarantee: number | null = null;
  const gPatterns = [
    /\$\s*([\d,]+(?:\.\d+)?)\s*(?:guarantee|g'tee|gtee)\b/gi,
    /deal:\s*\$\s*([\d,]+(?:\.\d+)?)\b/gi,
    /^\$\s*([\d,]+(?:\.\d+)?)\s+vs\b/gim,
    /\b([\d,]+(?:\.\d+)?)\s*g'tee\b/gi,
  ];
  for (const re of gPatterns) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const v = parseMoneyChunk(m[1]);
      if (v != null && v > 100) {
        guarantee = v;
        break;
      }
    }
    if (guarantee != null) break;
  }

  let percentage: number | null = null;

  const splitRatio =
    /(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*(?:after expenses|after)/i.exec(
      text,
    );
  if (splitRatio) {
    const a = Number.parseFloat(splitRatio[1]);
    const b = Number.parseFloat(splitRatio[2]);
    if (Number.isFinite(a) && Number.isFinite(b) && Math.abs(a + b - 100) < 2) {
      percentage = a / 100;
    }
  }

  const pctGross =
    /(\d+(?:\.\d+)?)\s*%\s*(?:of gross|gross)/i.exec(text);
  if (pctGross) {
    const p = Number.parseFloat(pctGross[1]);
    if (Number.isFinite(p) && p > 0 && p <= 100) percentage = p / 100;
  }

  if (percentage == null) {
    const pctNet =
      /(\d+(?:\.\d+)?)\s*%\s*(?:of net|net after|net)/i.exec(text);
    if (pctNet) {
      const p = Number.parseFloat(pctNet[1]);
      if (Number.isFinite(p) && p > 0 && p <= 100) percentage = p / 100;
    }
  }

  if (percentage == null) {
    const vsPct = /\bvs\s+(\d+(?:\.\d+)?)\s*%/i.exec(text);
    if (vsPct) {
      const p = Number.parseFloat(vsPct[1]);
      if (Number.isFinite(p) && p > 0 && p <= 100) percentage = p / 100;
    }
  }

  let percentageBasis: ExtractedNums["percentageBasis"] = null;
  if (/% of gross|\bvs\b[^.]{0,80}\bgross\b|no expense deductions/i.test(lower)) {
    percentageBasis = "gross";
  } else if (
    /% of net|after expenses|net after/i.test(lower) ||
    /\d+\s*\/\s*\d+\s*after/i.test(lower)
  ) {
    percentageBasis = "net_after_effective_expenses";
  }

  let expenseCap: number | null = null;
  const capPatterns = [
    /expenses?\s+capped\s+\$?\s*([\d,]+(?:\.\d+)?)/i,
    /expense[s]?\s+cap(?:ped)?\s+\$?\s*([\d,]+(?:\.\d+)?)/i,
    /expense\s+cap\s+\$?\s*([\d,]+(?:\.\d+)?)/i,
    /expenses\s+to\s+\$?\s*([\d,]+(?:\.\d+)?)/i,
    /expenses\s+to\s+([\d,]+(?:\.\d+)?)/i,
  ];
  for (const re of capPatterns) {
    const m = re.exec(text);
    if (m) {
      expenseCap = parseMoneyChunk(m[1]);
      if (expenseCap != null) break;
    }
  }

  let hospitalityCap: number | null = null;
  const hospPatterns = [
    /hospitality\s+cap\s+\$?\s*([\d,]+(?:\.\d+)?)/i,
    /hosp(?:itality)?\s+\$?\s*([\d,]+(?:\.\d+)?)/i,
  ];
  for (const re of hospPatterns) {
    const m = re.exec(text);
    if (m) {
      hospitalityCap = parseMoneyChunk(m[1]);
      if (hospitalityCap != null) break;
    }
  }

  return {
    guarantee,
    percentage,
    percentageBasis,
    expenseCap,
    hospitalityCap,
  };
}

// ---------------------------------------------------------------------------
// Warnings + narrative
// ---------------------------------------------------------------------------

function buildWarnings(ctx: {
  parsed: VsParsedDealTerms;
  structured: Deal;
  notesGuarantee: number | null;
  notesPct: number | null;
  grossBoxOffice: number;
  netBoxOffice: number;
  passedThroughExpenses: number;
  settlement: Settlement | null;
  recoups: Recoup[];
  illustrativeTotalToArtist: number | null;
  percentPathPayout: number | null;
  guarantee: number | null;
}): VsConfidenceWarning[] {
  const w: VsConfidenceWarning[] = [];
  const { structured, settlement, parsed } = ctx;

  if (parsed.variantFlags.includes("walkout_pot")) {
    w.push({
      severity: "warning",
      title: "Walkout language in the deal",
      detail:
        "Walkout / incremental splits are not modeled here. Confirm breakeven and the pot mechanics on the spreadsheet before you explain numbers.",
    });
  }
  if (parsed.variantFlags.includes("tier_ratchet_or_escalator")) {
    w.push({
      severity: "warning",
      title: "Ratchet or escalator in the deal",
      detail:
        "The percentage may change at certain sell-through points. This layer uses a single % — verify the correct tier for tonight’s house.",
    });
  }
  if (parsed.variantFlags.includes("percent_of_gross_basis_in_notes")) {
    w.push({
      severity: "info",
      title: "% of gross called out in notes",
      detail:
        "The walkthrough treats the % path as gross-based when prose indicates that. If your venue treats fees differently, reconcile with finance.",
    });
  }
  if (parsed.variantFlags.includes("bonuses_mentioned_in_prose_only")) {
    w.push({
      severity: "info",
      title: "Bonuses mentioned only in prose",
      detail:
        "Structured bonuses JSON is empty but the notes mention bonuses — the illustrative total may be low.",
    });
  }

  const sg = structured.guaranteeAmount;
  if (ctx.notesGuarantee != null && sg != null && Math.abs(ctx.notesGuarantee - sg) > 1) {
    w.push({
      severity: "warning",
      title: "Guarantee: notes vs structured field",
      detail: `Notes parse ~${money(ctx.notesGuarantee)} but structured guarantee is ${money(sg)}.`,
    });
  }

  const sp = structured.percentage;
  if (ctx.notesPct != null && sp != null && Math.abs(ctx.notesPct - sp) > 0.005) {
    w.push({
      severity: "warning",
      title: "Percentage: notes vs structured field",
      detail: `Notes parse ~${(ctx.notesPct * 100).toFixed(2)}% but structured percentage is ${(sp * 100).toFixed(2)}%.`,
    });
  }

  if (
    structured.percentageBasis === "gross" &&
    parsed.percentageBasis === "net_after_effective_expenses" &&
    !parsed.variantFlags.includes("percent_of_gross_basis_in_notes")
  ) {
    w.push({
      severity: "warning",
      title: "Basis mismatch (structured vs notes)",
      detail:
        "Structured `percentage_basis` is gross but notes language looks like net-after-expenses — confirm which email version controls.",
    });
  }

  if (settlement?.grossBoxOffice != null) {
    const delta = Math.abs(settlement.grossBoxOffice - ctx.grossBoxOffice);
    if (delta > 1) {
      w.push({
        severity: "info",
        title: "Logged gross differs from current ticket rows",
        detail: `Settlement record has ${money(settlement.grossBoxOffice)} gross; summed ticket sales are ${money(ctx.grossBoxOffice)}.`,
      });
    }
  }

  if (settlement?.netBoxOffice != null) {
    const delta = Math.abs(settlement.netBoxOffice - ctx.netBoxOffice);
    if (delta > 5) {
      w.push({
        severity: "info",
        title: "Logged net differs from gross − fees",
        detail: `Settlement record net ${money(settlement.netBoxOffice)} vs ${money(ctx.netBoxOffice)} from ticket sales.`,
      });
    }
  }

  if (settlement?.totalExpenses != null) {
    const delta = Math.abs(settlement.totalExpenses - ctx.passedThroughExpenses);
    if (delta > 5) {
      w.push({
        severity: "info",
        title: "Logged expenses differ from passed-through rows",
        detail: `Settlement has ${money(settlement.totalExpenses)} expenses; expense lines total ${money(ctx.passedThroughExpenses)}.`,
      });
    }
  }

  const logged = settlement?.totalToArtist;
  if (
    logged != null &&
    ctx.illustrativeTotalToArtist != null &&
    !parsed.variantFlags.includes("walkout_pot") &&
    !parsed.variantFlags.includes("tier_ratchet_or_escalator")
  ) {
    const tol = Math.max(75, Math.abs(ctx.illustrativeTotalToArtist) * 0.02);
    if (Math.abs(logged - ctx.illustrativeTotalToArtist) > tol) {
      w.push({
        severity: "warning",
        title: "Logged artist total vs illustrative Vs math",
        detail: `Greenroom shows ${money(logged)} to artist; the simple illustrative max is ~${money(ctx.illustrativeTotalToArtist)}. The gap may be bonuses, recoups, hospitality, walkouts, or spreadsheet adjustments.`,
      });
    }
  }

  const disputedRecoups = ctx.recoups.filter((r) => r.status === "disputed");
  if (disputedRecoups.length > 0) {
    w.push({
      severity: "warning",
      title: `${disputedRecoups.length} disputed recoup(s)`,
      detail:
        "Recoups change what is left for the artist — this walkthrough does not net them in.",
    });
  }

  return w;
}

function buildTourManagerScript(ctx: {
  parsed: VsParsedDealTerms;
  grossBoxOffice: number;
  netBoxOffice: number;
  passedThroughExpenses: number;
  effectiveExpenses: number;
  illustrativeTotalToArtist: number | null;
  guarantee: number | null;
  percentPathPayout: number | null;
  settlementTotal: number | null;
  variantBlocksIllustrative: boolean;
  recoupDisputed: boolean;
}): string {
  const parts: string[] = [];

  parts.push(
    `Here's how I'm reading tonight's Vs deal on my side: gross was about ${money(ctx.grossBoxOffice)} and net after fees was about ${money(ctx.netBoxOffice)}.`,
  );

  if (ctx.passedThroughExpenses > 0) {
    parts.push(
      `Passed-through expenses in Greenroom are ${money(ctx.passedThroughExpenses)}; for the % path I'm treating ${money(ctx.effectiveExpenses)} as the effective expense bucket when a cap applies.`,
    );
  }

  if (ctx.variantBlocksIllustrative) {
    parts.push(
      "The deal text includes a walkout or ratchet — I'm not going to quote a single computer number for that; the spreadsheet is the source of truth for the incremental split.",
    );
  } else if (
    ctx.guarantee != null &&
    ctx.percentPathPayout != null &&
    ctx.illustrativeTotalToArtist != null
  ) {
    const higher =
      ctx.guarantee >= ctx.percentPathPayout ? "the guarantee" : "the percentage";
    parts.push(
      `On a plain Vs shape, the guarantee is ${money(ctx.guarantee)} and the ~${money(ctx.percentPathPayout)} percentage leg means ${higher} is larger tonight — roughly ${money(ctx.illustrativeTotalToArtist)} illustrative before recoups or bonuses that aren't in the structured fields.`,
    );
  }

  if (ctx.settlementTotal != null) {
    parts.push(
      `The number logged in Greenroom for your payout is ${money(ctx.settlementTotal)} — that's what we signed around, and it may differ slightly from a back-of-envelope Vs max if finance applied caps, recoups, or bonuses.`,
    );
  }

  if (ctx.recoupDisputed) {
    parts.push(
      "There are disputed recoup lines — we're not done until those are cleared.",
    );
  }

  parts.push(
    "I'm not asking you to trust the automated math blind — this is me showing my work so we can align on what moved the number.",
  );

  return parts.join(" ");
}