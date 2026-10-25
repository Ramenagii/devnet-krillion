# Krillion interface and motion notes

**Reference checked:** 25 October 2026
**Target:** [krillion.io](https://krillion.io/)

This note separates details visible on Krillion’s public pages from behavior described in its FAQ/privacy pages. The live landing page exposes only a small amount of rendered content to this inspection, so exact transition timing, easing curves, and animation implementation are not confirmed here.

## How the experience is organized

- **Daily dive is the entry point.** The landing page centers a “Dive in” action, with the daily game as the primary route.
- **Other modes live in navigation.** The menu links to Daily dive, Unlimited, Puffer Party, Archive, themed packs, My Krillion, Friends, Settings, FAQ, and the merch shop. This keeps the daily game as the default while offering other destinations.
- **The game uses question-specific accepted answers.** Krillion’s FAQ says answer sets are curated from relevant sources (such as dictionaries, encyclopedias, and wiki pages), then merged and cleaned. Aliases are included, and near-typos can be autocorrected.
- **Scoring rewards uncommon answers.** The FAQ describes familiarity data for some prompts and a combination of LLM assistance and manual review for cases that cannot be scored mechanically. Rarity is balanced with “fun factor”; it is not simply a contest to find the most obscure technically valid answer.
- **Some modes are free-form and some are curated packs.** The public navigation includes daily, unlimited, archive, themed packs, and Puffer Party. The packs page presents packs as separate themed journeys.

## Motion and visual behavior

### Direct observations

- The landing page’s accessible text exposes a hero state reading **“descending…”** alongside an image. This suggests an atmospheric dive/arrival sequence, but the text snapshot does not show the animation frames.
- The main navigation is presented as a menu with a close button and links to the game’s sections.
- The current page snapshot does not provide enough visual/runtime detail to verify the exact animation, duration, easing, or whether the effect repeats.

### Design interpretation for DevNet Krillion

Use Krillion’s **quiet, staged pacing**: a restrained landing state, one clear action to enter the daily dive, and separate navigation for Play and Battle. Translate “descending” into a slow background/hero drift and a short, soft entrance when a view changes. Keep the movement on transforms and opacity so it stays smooth on mobile. Avoid flashing stars, rapid loops, or extra decorative movement that competes with the prompt.

The current app’s CSS implements that interpretation with a slow nebula drift, an aurora-like hero sweep, a single low-key comet pass, and short view/card entrances. These are implementation choices inspired by the supplied galaxy artwork and the reference’s pacing; they are **not claimed to be Krillion’s original animation code**.

The answer reveal uses the supplied Stitch meteor scenes as full-screen rarity animations, preceded by a shared galaxy gather and star-flare transition. Gemini returns a rarity score from 1 to 100, mapped by fixed thresholds: **Common** (1–20), **Uncommon** (21–40), **Rare** (41–60), **Epic** (61–80), and **Legendary** (81–100). Planet-like guide arcs, shockwave rings, and repeating pulse effects are removed from the web versions. The motion honors reduced-motion settings.

For scoring, Gemini estimates answer rarity only; the Edge Function applies the tier thresholds. Supabase compares the answer with the question’s reference phrases to estimate concept closeness, then combines closeness and tier for reward points. The separate rarity score is shown with the full-screen tier animation. There is no right/wrong result. Rarity scores are model estimates until a curated frequency dataset is connected.

## Useful product implications

1. Keep the landing page free of the active question. Let the player deliberately start a dive.
2. Put multiplayer in its own Battle destination, with room creation/joining and a visible room code.
3. Build accepted-answer data per question, including aliases and source notes; score answer closeness and familiarity instead of treating one exact string as the sole correct response.
4. Keep the answer curation process auditable: retain the answer variant, aliases, source URL/title, review status, and any scoring/familiarity signal.

## Sources

- [Krillion home](https://krillion.io/) — public navigation and landing-page text.
- [Krillion FAQ](https://krillion.io/faq) — answer-set curation, aliases/autocorrect, rarity scoring, and the role of editorial review.
- [Krillion privacy policy](https://krillion.io/privacy) — guest/account behavior and what data the game stores or discards.
- [Themed packs](https://krillion.io/packs) — examples of the archive and themed-pack destinations.
