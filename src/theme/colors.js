/**
 * src/theme/colors.js
 * ---------------------------------------------------------------------------
 * XCEPTA institutional palette — design-token foundation (UI refresh Phase A).
 *
 * Single source of truth for application colors. Mirrored as CSS variables
 * in src/index.css so .css files and inline JSX styles can both read the
 * same palette. Tokens are intended to be imported by JSX components:
 *
 *   import { colors } from '../theme/colors'
 *   <div style={{ background: colors.surface, color: colors.textPrimary }} />
 *
 * Phase A introduces the tokens only. No JSX repaint yet — components
 * continue to use hardcoded hex until Phase B onwards migrates them.
 *
 * Palette design notes:
 *   - bg / surface / surfaceElevated form a 3-tier dark hierarchy on a
 *     harbor-navy base (#061A24).
 *   - accent is institutional aqua (#0FA3B1). Reserved for primary CTA,
 *     active nav, link text, primary chart series, and focus rings —
 *     used sparingly so it reads as accent, not as fill.
 *   - accentSoft (#B5E2FA) is a pale highlight surface for badges and
 *     info chips on dark backgrounds.
 *   - Semantic (success / warning / danger) is intentionally less
 *     saturated than the previous GitHub palette to read as
 *     institutional rather than alarming.
 *   - Chart palette is sequential-categorical (aqua → slate → emerald →
 *     violet → neutral) — color-blind friendlier than red/green/yellow.
 *   - Print tokens (bottom) keep the PDF export on a light palette by
 *     design; they intentionally do NOT mirror the dark UI.
 * ---------------------------------------------------------------------------
 */
export const colors = Object.freeze({
  // ── Backgrounds (deepest → lightest) ────────────────────────────────────
  bg:              '#061A24',  // deep harbor navy — page background
  bgSubtle:        '#0A2433',  // slight lift above bg (gradient ends, footers)
  surface:         '#0B3A53',  // sidebar, primary surfaces
  surfaceElevated: '#103D58',  // cards and panels lifted above surface
  surfaceMuted:    '#082C40',  // sunken surfaces (table headers, wells)

  // ── Borders / dividers ──────────────────────────────────────────────────
  border:          '#19475F',  // standard divider
  borderMuted:     '#0F3245',  // soft separator (low-emphasis row lines)
  borderStrong:    '#23607D',  // hover/focused borders, active table edges

  // ── Text ────────────────────────────────────────────────────────────────
  textPrimary:     '#F3FAFF',  // off-white headings/body
  textSecondary:   '#A5C7DA',  // slate-cyan body / secondary text
  textMuted:       '#5C7F92',  // captions, disabled labels
  textInverse:     '#061A24',  // dark text on accentSoft / pale surfaces

  // ── Accent (institutional aqua) ─────────────────────────────────────────
  accent:          '#0FA3B1',  // primary accent — CTA, active nav, links
  accentHover:     '#10B8C8',  // hover / lift
  accentSoft:      '#B5E2FA',  // pale highlight surface (badges, info chips)
  accentBgSubtle:  'rgba(15, 163, 177, 0.10)',  // tinted hover/active backdrop

  // ── Semantic (muted institutional) ──────────────────────────────────────
  success:         '#2EA77A',  // muted emerald (was GitHub #3fb950)
  successSoft:     'rgba(46, 167, 122, 0.12)',
  warning:         '#C19132',  // muted amber (was GitHub #d29922)
  warningSoft:     'rgba(193, 145, 50, 0.12)',
  danger:          '#D9534F',  // muted rust (was GitHub #f85149)
  dangerSoft:      'rgba(217, 83, 79, 0.12)',

  // ── Charts (sequential-categorical) ─────────────────────────────────────
  chartRevenue:    '#0FA3B1',  // aqua (positive cash inflow)
  chartCost:       '#7AA0B3',  // slate (cost / expense)
  chartEquity:     '#2EA77A',  // muted emerald
  chartDebt:       '#9D7BCC',  // soft institutional violet
  chartNeutral:    '#5C7F92',  // neutral / "other" series
  chartGrid:       '#19475F',  // subtle gridlines
  chartAxis:       '#A5C7DA',  // axis labels

  // ── Print / PDF (intentionally light theme) ─────────────────────────────
  printBg:         '#FFFFFF',
  printPanel:      '#F3FAFF',
  printBorder:     '#D7E3EC',
  printText:       '#0B2A3A',
})

export default colors
