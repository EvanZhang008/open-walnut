#if DEBUG
import Foundation

/// Rich-HTML transcript fixtures for the DEBUG timeline harness.
///
/// Rich output mode lets the model answer in raw HTML, which the console renders
/// natively; the phone renders the HTML runs in web-view rows. Verifying that by
/// hand used to mean provoking a real CLI turn into writing a card, which is slow
/// and never reproduces the same markup twice. These are the shapes the
/// `rich-output` skill actually teaches, so the harness can show every one of them
/// in the simulator with no server and no model.
///
/// Each fixture is deliberately a WHOLE assistant message, blank lines included:
/// the chunk boundaries are part of what is under test (a `<style>` block and the
/// markup it styles routinely land in different chunks, and prose either side of a
/// card must stay native text rows).
enum TimelineRichFixtures {
    /// Theme-variable callout — the single most common shape a reply uses.
    static let callout = """
    Here is what the trace actually shows.

    <div style="border:1px solid var(--border);border-left:4px solid var(--accent);border-radius:10px;padding:12px 16px;background:var(--bg-secondary)">
    <b style="color:var(--accent)">Conclusion</b><br>The retry storm is the symptom; the cache stampede is the cause.
    </div>

    The rest of this reply is ordinary markdown, so it stays a native text row.
    """

    /// A `<style>` block and the markup it styles, separated by a blank line — so
    /// they are DIFFERENT chunks. Each html run is its own document on the phone,
    /// so the styles have to be carried into every run or this card arrives naked.
    static let styledCard = """
    <style>
    .grid { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
    .cell { padding:10px; border-radius:8px; background:var(--bg-secondary); color:var(--fg); }
    .cell b { color:var(--accent); }
    </style>

    <div class="grid">
      <div class="cell"><b>Before</b><br>3 round trips per file</div>
      <div class="cell"><b>After</b><br>1 batched call</div>
    </div>
    """

    /// Hardcoded colours, both ends of every pair set (the contrast rule).
    static let contrastPanels = """
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <div style="background:#fff5f5;color:#7f1d1d;padding:10px;border-radius:8px;flex:1 1 120px">Fails closed</div>
      <div style="background:#f0fdf4;color:#14532d;padding:10px;border-radius:8px;flex:1 1 120px">Fails open</div>
    </div>
    """

    /// The shape a REAL reply keeps writing, and the one every other fixture here
    /// was too well-behaved to show: a background pinned, the text colour left to
    /// inherit. On a dark transcript the near-white `--fg` used to land on that pale
    /// panel at 1.02:1 (measured on production replies, 16 of 25 of them), so the
    /// renderer pairs a colour with any background an author leaves unpaired.
    ///
    /// The `<code>` and the `<blockquote>` are the point of the second panel: they
    /// carry the app's OWN themed colours, so they are what proves the paired panel
    /// switches the whole variable set and not just one `color` — the version that
    /// only set `color` left every inline code chip at 1.01:1 on real transcripts.
    /// The third panel is the mirror (dark background, light transcript).
    static let unpairedBackgrounds = """
    <div style="background:#fff5f5;padding:10px;border-radius:8px">
      Retry budget exhausted after the third attempt.
    </div>

    <div style="background:#f0f0f0;padding:10px;border-radius:8px;margin-top:8px">
      Run <code>stat /tmp/oom-dash/ghost-file-*.log</code> before touching the queue.
      <blockquote>The daemon owns the pipe, not the server.</blockquote>
      <a href="https://example.com/runbook">Runbook</a>
    </div>

    <div style="background:#161b22;padding:10px;border-radius:8px;margin-top:8px">
      Mirror case: a dark panel with <code>--verbose</code> in a light transcript.
    </div>
    """

    /// The SVG shapes the renderer has to tell apart, which no other fixture showed.
    ///
    /// SVG text is painted by `fill`, whose initial value is BLACK, so a label that
    /// sets none is invisible on a dark page — unless the diagram painted a light
    /// shape behind it, in which case black is exactly right and the page's near-white
    /// ink is what disappears. Both directions were measured on real replies
    /// (1.11:1 and 1.09:1), so both live here: an outline diagram whose labels belong
    /// to the page, and a filled diagram whose labels belong to its own boxes.
    static let svgLabels = """
    <svg viewBox="0 0 260 40" style="width:100%;max-width:320px">
      <rect x="1" y="6" width="120" height="28" rx="6" fill="none" stroke="var(--accent)"/>
      <text x="10" y="24" font-size="11">outline: label is on the page</text>
    </svg>

    <svg viewBox="0 0 260 40" style="width:100%;max-width:320px">
      <rect x="1" y="6" width="258" height="28" rx="6" fill="#ffffff"/>
      <text x="10" y="24" font-size="11">filled: label is on the author's box</text>
    </svg>
    """

    /// SVG diagram: vector, scales with the row width, no scripting.
    static let svgDiagram = """
    <svg viewBox="0 0 260 70" style="width:100%;max-width:320px">
      <rect x="2" y="18" width="70" height="34" rx="6" fill="none" stroke="var(--accent)"/>
      <text x="37" y="39" font-size="11" text-anchor="middle" fill="var(--fg)">phone</text>
      <line x1="72" y1="35" x2="108" y2="35" stroke="var(--border-strong)"/>
      <rect x="108" y="18" width="70" height="34" rx="6" fill="none" stroke="var(--accent)"/>
      <text x="143" y="39" font-size="11" text-anchor="middle" fill="var(--fg)">server</text>
      <line x1="178" y1="35" x2="214" y2="35" stroke="var(--border-strong)"/>
      <rect x="214" y="18" width="44" height="34" rx="6" fill="none" stroke="var(--accent)"/>
      <text x="236" y="39" font-size="11" text-anchor="middle" fill="var(--fg)">CLI</text>
    </svg>
    """

    /// CSS-only interactivity: a `<details>` and a `:checked`-sibling stepper.
    /// Nothing here needs JavaScript, which is the whole point — tapping these in
    /// the simulator proves the row is live DOM and not a screenshot of one.
    static let cssInteractive = """
    <details style="border:1px solid var(--border);border-radius:8px;padding:8px 12px">
    <summary style="cursor:pointer;color:var(--accent)">Why the deadline is 30s</summary>
    <p style="color:var(--fg)">Whoever holds the shorter deadline defines the contract.</p>
    </details>

    <style>
    .step { display:none; color:var(--fg); }
    #s1:checked ~ .steps .step1, #s2:checked ~ .steps .step2 { display:block; }
    .tabs label { padding:4px 10px; border:1px solid var(--border); border-radius:999px; color:var(--fg-muted); }
    </style>

    <div>
      <input type="radio" id="s1" name="s" checked hidden><input type="radio" id="s2" name="s" hidden>
      <div class="tabs"><label for="s1">Step 1</label><label for="s2">Step 2</label></div>
      <div class="steps">
        <div class="step step1">Send lands in the durable queue.</div>
        <div class="step step2">The runner drains it into the live process.</div>
      </div>
    </div>
    """

    /// A ```html-app island: the ONLY way a script runs, in its own sandbox.
    static let island = """
    Tap the button — this one really is running JavaScript.

    ```html-app
    <div style="font:-apple-system-body;font-family:-apple-system,sans-serif;color:#1c1c1e">
      <button id="b" style="padding:8px 14px;border-radius:8px;border:1px solid #8B5A2B;background:#fff;color:#8B5A2B">counted 0</button>
      <script>
        let n = 0;
        document.getElementById('b').onclick = () => { n++; document.getElementById('b').textContent = `counted ${n}`; };
      </script>
    </div>
    ```
    """

    /// Every fixture as a message list, oldest first.
    static func messages(startingAt index: Int) -> [(id: String, text: String)] {
        let bodies = [callout, styledCard, contrastPanels, unpairedBackgrounds,
                      svgDiagram, svgLabels, cssInteractive, island]
        return bodies.enumerated().map { offset, text in
            ("rich-\(index + offset)", text)
        }
    }

    /// Progressive prefixes of a rich reply, for the streaming path: the tail is
    /// mid-tag at several points, which is exactly when a naive renderer paints
    /// half a `<div` as text (or auto-closes it into an empty coloured pill).
    static func streamingChunks() -> [String] {
        [
            "Working through it now.\n\n",
            "<div style=\"border:1px solid var(--border);border-radius:10px;",
            "padding:12px;background:var(--bg-secondary);color:var(--fg)\">\n",
            "<b style=\"color:var(--accent)\">Step 1</b><br>Read the queue row.\n",
            "<br><b style=\"color:var(--accent)\">Step 2</b><br>Drain it into the process.\n",
            "</div>\n\n",
            "That is the whole path — the rest is bookkeeping.",
        ]
    }
}
#endif
