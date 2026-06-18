// ─── AI PAGE ANALYSIS MODULE (Gemini Vision) ─────────────────────────────────
// Sends the current PDF canvas to Gemini 2.0 Flash vision API and returns
// a structured list of all electrical elements identified on the SLD.

async function runAIPageAnalysis() {
    const keyInput = document.getElementById('gemini-api-key-input');
    const apiKey = (keyInput ? keyInput.value.trim() : '') ||
                   (localStorage.getItem('gemini_api_key') || '').trim();

    const modelSelect = document.getElementById('gemini-model-select');
    const model = (modelSelect ? modelSelect.value : '') ||
                  (localStorage.getItem('gemini_model') || 'gemini-2.0-flash');

    const resultsEl = document.getElementById('ai-analysis-results');
    const btn       = document.getElementById('btn-ai-analyze');
    const badge     = document.getElementById('ai-status-badge');

    if (!apiKey) {
        if (resultsEl) resultsEl.innerHTML =
            "<p style='color:#f87171;font-size:11px;padding:4px 0;'>⚠️ Paste your Gemini API key above first. " +
            "<a href='https://aistudio.google.com/app/apikey' target='_blank' style='color:#60a5fa;'>Get one free ↗</a></p>";
        return;
    }

    const canvas = document.getElementById('pdf-canvas');
    if (!canvas || !currentPDF || !currentPDF.doc) {
        alert('Please load a PDF page first.');
        return;
    }

    // Capture canvas as compressed JPEG (faster than PNG)
    const imageData = canvas.toDataURL('image/jpeg', 0.82).split(',')[1];

    // UI: busy state
    if (btn)  { btn.disabled = true; btn.textContent = '⏳ Analyzing with Gemini...'; }
    if (badge) badge.textContent = 'Analyzing...';
    if (resultsEl) resultsEl.innerHTML =
        "<div class='ai-thinking'>" +
        "<div class='ai-thinking-dots'><span></span><span></span><span></span></div>" +
        "<span>Gemini Vision is reading the drawing...</span></div>";

    const prompt =
        "You are an expert electrical engineer reviewing an electrical Single Line Diagram (SLD) " +
        "drawing exported from AutoCAD.\n\n" +
        "Analyze this SLD image carefully and extract ALL labeled elements visible on the drawing.\n" +
        "Return ONLY a valid JSON object with NO markdown fences, NO explanation — just the JSON:\n\n" +
        '{"drawing_title":"string or null","scale":"string or null","elements":[' +
        '{"type":"panel|cable|breaker|load|bus|ct|meter|bms|spare|label|other",' +
        '"label":"exact text as seen in drawing",' +
        '"description":"brief description of this element",' +
        '"circuit_from":"source panel/bus name if traceable, else null",' +
        '"circuit_to":"destination panel/load name if traceable, else null",' +
        '"spec":"technical rating or size if present, else null",' +
        '"zone":"drawing or title_block"}' +
        '],"summary":"2-3 sentence summary of what this SLD shows"}\n\n' +
        "EXTRACTION RULES:\n" +
        "- Include EVERY labeled element — no matter how small or rotated\n" +
        "- Vertical text is always a cable spec or panel name — include it\n" +
        "- Cables: full string e.g. '1Rx4Cx10sqmm Cu. AR. CABLE' — type=cable\n" +
        "- Distribution panels/DBs: full name e.g. 'HUB ROOM DB-1B' — type=panel\n" +
        "- WORKSTATION labels — type=load\n" +
        "- SPARE feeders — each one separately — type=spare\n" +
        "- Circuit breakers/MCCBs with ratings — type=breaker, spec=rating\n" +
        "- BMS, CTs, meters — classify accordingly\n" +
        "- zone='title_block' ONLY for items in the bottom-right title block rectangle\n" +
        "- zone='drawing' for everything else in the diagram area\n" +
        "- circuit_from and circuit_to: trace the line connections where possible";

    try {
        const response = await fetch(
            'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + apiKey,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{
                        parts: [
                            { text: prompt },
                            { inline_data: { mime_type: 'image/jpeg', data: imageData } }
                        ]
                    }],
                    generationConfig: {
                        temperature: 0.1,
                        maxOutputTokens: 8192
                    }
                })
            }
        );

        if (!response.ok) {
            let errMsg = 'HTTP ' + response.status;
            try {
                const errData = await response.json();
                errMsg = (errData.error && errData.error.message) ? errData.error.message : errMsg;
            } catch(e) {}
            throw new Error(errMsg);
        }

        const data = await response.json();
        const candidate = (data.candidates || [])[0];
        const rawText = (candidate && candidate.content && candidate.content.parts &&
                         candidate.content.parts[0] && candidate.content.parts[0].text) || '';

        // Strip any accidental markdown fences
        const cleaned = rawText
            .replace(/^```json\s*/m, '')
            .replace(/^```\s*/m, '')
            .replace(/```\s*$/m, '')
            .trim();

        let parsed;
        try {
            parsed = JSON.parse(cleaned);
        } catch(e) {
            throw new Error('AI returned invalid JSON. Snippet: ' + rawText.substring(0, 300));
        }

        renderAIResults(parsed);
        const count = (parsed.elements || []).length;
        if (badge) badge.textContent = count + ' elements found';
        setStatus('AI identified ' + count + ' elements on this page.');

    } catch(err) {
        if (resultsEl) resultsEl.innerHTML =
            "<p style='color:#f87171;font-size:11px;padding:4px;'>❌ " + escapeHTML(err.message) + "</p>";
        if (badge) badge.textContent = 'Error';
        console.error('AI Analysis error:', err);
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = '🤖 Identify All Elements on This Page';
        }
    }
}

// ── Render AI JSON results as colour-coded element cards ──────────────────────
function renderAIResults(data) {
    const el = document.getElementById('ai-analysis-results');
    if (!el) return;

    const elements = data.elements || [];
    if (elements.length === 0) {
        el.innerHTML = "<p style='color:var(--fg-dim);font-size:11px;'>No elements were identified.</p>";
        return;
    }

    // Visual styling per element type
    const TYPE_STYLE = {
        panel:   { color: '#38bdf8', badge: 'DB',  label: 'Panels / DBs'       },
        cable:   { color: '#4ade80', badge: 'CBL', label: 'Cables'             },
        breaker: { color: '#fb923c', badge: 'CB',  label: 'Breakers'           },
        load:    { color: '#c084fc', badge: 'LD',  label: 'Loads / Equipment'  },
        bus:     { color: '#f472b6', badge: 'BUS', label: 'Busbars'            },
        ct:      { color: '#fbbf24', badge: 'CT',  label: 'Current Transformers'},
        meter:   { color: '#34d399', badge: 'MTR', label: 'Meters'             },
        bms:     { color: '#60a5fa', badge: 'BMS', label: 'BMS Points'         },
        spare:   { color: '#9ca3af', badge: 'SPA', label: 'Spare Ways'         },
        label:   { color: '#94a3b8', badge: 'LBL', label: 'Labels'             },
        other:   { color: '#6b7280', badge: '···', label: 'Other'              }
    };
    const ORDER = ['panel','cable','breaker','load','bus','ct','meter','bms','spare','label','other'];

    // Group by type
    const groups = {};
    elements.forEach(function(e) {
        const t = (e.type || 'other').toLowerCase();
        if (!groups[t]) groups[t] = [];
        groups[t].push(e);
    });

    let html = '';

    // Summary card
    if (data.summary) {
        html += '<div class="ai-summary">' + escapeHTML(data.summary) + '</div>';
    }
    if (data.drawing_title) {
        html += '<div class="ai-drawing-meta">' + escapeHTML(data.drawing_title);
        if (data.scale) html += ' &nbsp;|&nbsp; Scale: ' + escapeHTML(data.scale);
        html += '</div>';
    }

    // Element groups
    ORDER.forEach(function(type) {
        const group = groups[type];
        if (!group || group.length === 0) return;
        const ts = TYPE_STYLE[type] || TYPE_STYLE.other;

        // Drawing items first, title block items last
        const drawingItems    = group.filter(function(e) { return e.zone !== 'title_block'; });
        const titleBlockItems = group.filter(function(e) { return e.zone === 'title_block'; });
        const sorted = drawingItems.concat(titleBlockItems);

        html += '<div class="ai-group">';
        html += '<div class="ai-group-header" style="border-left-color:' + ts.color + ';">';
        html += '<span class="ai-type-badge" style="background:' + ts.color + '1a;color:' + ts.color + ';">' + ts.badge + '</span>';
        html += '<span>' + ts.label + '</span>';
        html += '<span class="ai-group-count">' + group.length + '</span>';
        html += '</div>';

        sorted.forEach(function(item) {
            const isTitle  = (item.zone === 'title_block');
            const safeLabel= escapeHTML(item.label || '');
            // Safe onclick — escape single quotes in the label
            const jsLabel  = (item.label || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");

            html += '<div class="ai-element-card' + (isTitle ? ' ai-titleblock' : '') + '"';
            html += ' onclick="aiLocateOrSearch(\'' + jsLabel + '\')"';
            html += ' title="Click to search for this in annotation rows">';

            html += '<div class="ai-el-label" style="color:' + ts.color + ';">' + safeLabel + '</div>';

            if (item.spec) {
                html += '<div class="ai-el-spec">' + escapeHTML(item.spec) + '</div>';
            }
            if (item.description) {
                html += '<div class="ai-el-desc">' + escapeHTML(item.description) + '</div>';
            }
            if (item.circuit_from || item.circuit_to) {
                html += '<div class="ai-circuit">';
                if (item.circuit_from) {
                    html += '<span class="ai-circuit-node">' + escapeHTML(item.circuit_from) + '</span>';
                }
                if (item.circuit_from && item.circuit_to) {
                    html += ' <span style="color:var(--fg-dim);font-size:10px;">&#8594;</span> ';
                }
                if (item.circuit_to) {
                    html += '<span class="ai-circuit-node">' + escapeHTML(item.circuit_to) + '</span>';
                }
                html += '</div>';
            }
            html += '</div>';
        });

        html += '</div>';
    });

    el.innerHTML = html;
}

// ── Fuzzy-search a text annotation matching the AI label ─────────────────────
function findAnnotationByText(label) {
    if (!currentPDF || !currentPDF.rawAnnots) return null;
    const cleanLabel = label.trim().toLowerCase();
    
    // Helper to normalize strings for comparison, resolving common spelling and layout differences
    const normalize = s => s.toLowerCase()
        .replace(/accommodation/g, 'accomodation')
        .replace(/training/g, 'traing')
        .replace(/vacational/g, 'vactional')
        .replace(/centre/g, 'center')
        .replace(/[^a-z0-9]/g, '');

    const normLabel = normalize(cleanLabel);

    // 1. Try exact normalized match
    let match = currentPDF.rawAnnots.find(annot => {
        const text = ((annot.contentsObj ? annot.contentsObj.str : '') || annot.contents || '').trim();
        return normalize(text) === normLabel;
    });
    
    // 2. Try substring normalized match
    if (!match) {
        match = currentPDF.rawAnnots.find(annot => {
            const text = ((annot.contentsObj ? annot.contentsObj.str : '') || annot.contents || '').trim();
            const normText = normalize(text);
            return normText.includes(normLabel) || normLabel.includes(normText);
        });
    }
    
    return match;
}

// ── Click an AI result card to locate it on canvas and search sidebar ─────────
function aiLocateOrSearch(label) {
    // 1. Filter the annotation rows table in the sidebar
    const searchInput = document.getElementById('annot-search-input');
    if (searchInput) {
        searchInput.value = label;
        if (typeof filterAnnotRows === 'function') {
            filterAnnotRows(label);
        }
    }
    
    // 2. Try to locate and highlight on the canvas directly
    const matchedAnnot = findAnnotationByText(label);
    if (matchedAnnot && matchedAnnot.rect && typeof locateInspectorAnnotation === 'function') {
        const r = matchedAnnot.rect;
        locateInspectorAnnotation(r[0], r[1], r[2], r[3]);
        if (typeof setStatus === 'function') {
            setStatus('Located AI element on drawing: "' + label + '"');
        }
    } else {
        // Fallback: scroll drawing zone into view
        const drawingZone = document.getElementById('annot-zone-drawing');
        if (drawingZone) {
            drawingZone.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
        if (typeof setStatus === 'function') {
            setStatus('Searching annotations for: "' + label + '"');
        }
    }
}

// ── Dynamic Gemini Model Selector Loading ──────────────────────────────────
async function refreshModelSelect(apiKey = '') {
    const keyInput = document.getElementById('gemini-api-key-input');
    const key = apiKey || (keyInput ? keyInput.value.trim() : '') || (localStorage.getItem('gemini_api_key') || '').trim();
    const select = document.getElementById('gemini-model-select');
    if (!select) return;

    const savedModel = localStorage.getItem('gemini_model') || 'gemini-2.0-flash';

    // Static default fallback options (ordered with newest/best first)
    const defaults = [
        { id: 'gemini-2.0-flash', label: 'gemini-2.0-flash (Default)' },
        { id: 'gemini-2.5-flash', label: 'gemini-2.5-flash' },
        { id: 'gemini-3.5-flash', label: 'gemini-3.5-flash (Recommended)' },
        { id: 'gemini-3.0-flash', label: 'gemini-3-flash' },
        { id: 'gemini-3.1-flash-lite', label: 'gemini-3.1-flash-lite' },
        { id: 'gemini-3.1-pro', label: 'gemini-3.1-pro (High Quality)' },
        { id: 'gemini-2.5-pro', label: 'gemini-2.5-pro' }
    ];

    if (!key) {
        populateSelect(select, defaults, savedModel);
        return;
    }

    try {
        const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models?key=' + key);
        if (!res.ok) throw new Error();
        const data = await res.json();
        
        let models = (data.models || [])
            .filter(m => m.supportedMethods && m.supportedMethods.includes('generateContent'))
            .map(m => {
                const name = m.name.replace('models/', '');
                let label = name;
                if (name === 'gemini-2.0-flash') label += ' (Default)';
                else if (name === 'gemini-3.5-flash') label += ' (Recommended)';
                return { id: name, label: label };
            });

        if (models.length > 0) {
            // Sort models to make newest Flash/Pro options prominent
            models.sort((a, b) => {
                const isFlashA = a.id.includes('flash');
                const isFlashB = b.id.includes('flash');
                if (isFlashA && !isFlashB) return -1;
                if (!isFlashA && isFlashB) return 1;
                
                // Sort by version
                return b.id.localeCompare(a.id);
            });
            populateSelect(select, models, savedModel);
            return;
        }
    } catch(e) {
        console.warn('Failed to fetch dynamic models from Gemini API, using defaults.');
    }

    populateSelect(select, defaults, savedModel);
}

function populateSelect(select, items, selectedId) {
    select.innerHTML = '';
    let foundSelected = false;
    items.forEach(item => {
        const opt = document.createElement('option');
        opt.value = item.id;
        opt.textContent = item.label;
        if (item.id === selectedId) {
            opt.selected = true;
            foundSelected = true;
        }
        select.appendChild(opt);
    });
    
    // If saved model is not in the list, prepend it as custom option
    if (!foundSelected && selectedId) {
        const opt = document.createElement('option');
        opt.value = selectedId;
        opt.textContent = selectedId + ' (Custom)';
        opt.selected = true;
        select.prepend(opt);
    }
}

// ─── AI TOPOLOGY ANALYSIS ─────────────────────────────────────────────────────
async function runAITopologyAnalysis() {
    const keyInput = document.getElementById('gemini-api-key-input');
    const apiKey = (keyInput ? keyInput.value.trim() : '') ||
                   (localStorage.getItem('gemini_api_key') || '').trim();
    const modelSelect = document.getElementById('gemini-model-select');
    const model = (modelSelect ? modelSelect.value : '') ||
                  (localStorage.getItem('gemini_model') || 'gemini-2.0-flash');
    const resultsEl = document.getElementById('ai-topology-results');
    const btn = document.getElementById('btn-ai-topology');

    if (!apiKey) {
        if (resultsEl) resultsEl.innerHTML = "<p style='color:#f87171;font-size:11px;'>No API key.</p>";
        return;
    }
    const canvas = document.getElementById('pdf-canvas');
    if (!canvas || !currentPDF || !currentPDF.doc) { alert('Load a PDF first.'); return; }

    const imageData = canvas.toDataURL('image/jpeg', 0.82).split(',')[1];
    if (btn) { btn.disabled = true; btn.textContent = 'Analyzing topology...'; }
    if (resultsEl) resultsEl.innerHTML = "<div class='ai-thinking'><div class='ai-thinking-dots'><span></span><span></span><span></span></div><span>Tracing power flow...</span></div>";

    const topoPrompt = [
        'You are an electrical engineer analyzing a Single Line Diagram (SLD).',
        'Extract the POWER FLOW HIERARCHY. Return ONLY valid JSON with no markdown:',
        '{"incoming_supply":{"type":"HV|LV|Generator","voltage":"e.g.415V","description":"..."},',
        '"main_bus":{"label":"...","rating":"..."},',
        '"circuits":[{"id":1,"from":"source panel/bus","via_breaker":{"type":"ACB|MCCB|MCB","rating":"e.g.63A TPN","label":"..."},"to":"load or sub-panel name","cable":"cable spec or null","direction":"outgoing|incoming","sub_circuits":[]}],',
        '"notes":"..."}',
        'RULES: Trace EVERY breaker. Identify all loads by name (e.g. PARIJATHA SCHOOL, VACTIONAL TRAINING CENTER).',
        'Include cable sizes. Use direction=incoming for supply feeders into this panel.'
    ].join('\n');

    try {
        const resp = await fetch(
            'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + apiKey,
            { method: 'POST', headers: {'Content-Type':'application/json'},
              body: JSON.stringify({
                contents:[{parts:[{text:topoPrompt},{inline_data:{mime_type:'image/jpeg',data:imageData}}]}],
                generationConfig:{temperature:0.05,maxOutputTokens:8192}
              })
            }
        );
        if (!resp.ok) { const e = await resp.json().catch(() => ({})); throw new Error((e.error && e.error.message) || 'HTTP ' + resp.status); }
        const d = await resp.json();
        const raw = ((d.candidates || [])[0]?.content?.parts?.[0]?.text) || '';
        const cleaned = raw.replace(/^```json\s*/m,'').replace(/^```\s*/m,'').replace(/```\s*$/m,'').trim();
        let parsed;
        try { parsed = JSON.parse(cleaned); } catch(e) { throw new Error('Bad JSON: ' + raw.substring(0, 200)); }
        renderTopologyTree(parsed);
        if (typeof setStatus === 'function') setStatus('Topology: ' + (parsed.circuits || []).length + ' circuits traced.');
    } catch(err) {
        if (resultsEl) resultsEl.innerHTML = '<p style="color:#f87171;font-size:11px;">Error: ' + (typeof escapeHTML === 'function' ? escapeHTML(err.message) : err.message) + '</p>';
        console.error('Topology error:', err);
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Analyze Topology (Incoming / Outgoing)'; }
    }
}

function renderTopologyTree(data) {
    const el = document.getElementById('ai-topology-results');
    if (!el) return;
    const circuits = data.circuits || [];
    const supply = data.incoming_supply || {};
    const bus = data.main_bus || {};
    const esc = typeof escapeHTML === 'function' ? escapeHTML : (s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])));

    let html = '<div style="margin-top:6px;">';
    html += '<div style="font-size:10px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:8px;">Power Flow Topology</div>';

    if (supply.type || supply.description) {
        html += '<div style="display:flex;align-items:center;gap:6px;padding:6px 8px;background:rgba(251,191,36,0.1);border:1px solid rgba(251,191,36,0.3);border-radius:6px;margin-bottom:4px;">'
             + '<span style="font-size:14px;">\u2b06\ufe0f</span>'
             + '<div><div style="font-size:11px;font-weight:600;color:#fbbf24;">INCOMING: ' + esc(supply.type || 'Supply')
             + (supply.voltage ? ' (' + esc(supply.voltage) + ')' : '') + '</div>'
             + (supply.description ? '<div style="font-size:10px;color:#9ca3af;">' + esc(supply.description) + '</div>' : '')
             + '</div></div>';
    }
    if (bus.label || bus.rating) {
        html += '<div style="margin-left:12px;padding:4px 8px;border-left:2px solid #fbbf24;margin-bottom:4px;">'
             + '<div style="font-size:10px;color:#fbbf24;">\ud83d\ude8c Main Bus: ' + esc(bus.label || '') + (bus.rating ? ' (' + esc(bus.rating) + ')' : '') + '</div></div>';
    }

    function renderCircuit(c, ml) {
        const b = c.via_breaker || {};
        const bStr = [b.type, b.rating, b.label].filter(Boolean).join(' \u00b7 ');
        const subs = c.sub_circuits || [];
        const toJs = (c.to || '').replace(/\\/g,'\\\\').replace(/'/g,"\\'");
        return '<div style="margin-left:' + ml + 'px;margin-bottom:3px;">'
             + '<div style="display:flex;align-items:flex-start;gap:5px;padding:5px 8px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:5px;cursor:pointer;" onclick="aiLocateOrSearch(\'' + toJs + '\')" title="Locate on drawing">'
             + '<span style="font-size:11px;flex-shrink:0;margin-top:1px;">\u2b07\ufe0f</span>'
             + '<div style="flex:1;min-width:0;"><div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap;">'
             + '<span style="font-size:10px;color:#60a5fa;font-weight:600;">' + esc(c.from || '?') + '</span>'
             + (bStr ? '<span style="font-size:9px;color:#fb923c;background:rgba(251,146,60,0.12);padding:1px 4px;border-radius:3px;">[' + esc(bStr) + ']</span>' : '')
             + '<span style="font-size:9px;color:#6b7280;">&rarr;</span>'
             + '<span style="font-size:10px;color:#4ade80;font-weight:600;">' + esc(c.to || '?') + '</span>'
             + '</div>' + (c.cable ? '<div style="font-size:9px;color:#6b7280;">\ud83d\udd0c ' + esc(c.cable) + '</div>' : '')
             + '</div><span style="font-size:10px;color:#6b7280;">\ud83d\udccd</span></div>'
             + subs.map(sc => renderCircuit(sc, 14)).join('')
             + '</div>';
    }

    const outgoing = circuits.filter(c => c.direction !== 'incoming');
    const incoming = circuits.filter(c => c.direction === 'incoming');

    if (outgoing.length > 0) {
        html += '<div style="font-size:10px;color:#9ca3af;margin:6px 0 4px;font-weight:600;">OUTGOING CIRCUITS (' + outgoing.length + ')</div>';
        outgoing.forEach(c => { html += renderCircuit(c, 14); });
    }
    if (incoming.length > 0) {
        html += '<div style="font-size:10px;color:#9ca3af;margin:6px 0 4px;font-weight:600;">ADDITIONAL INCOMING</div>';
        incoming.forEach(c => { html += renderCircuit(c, 14); });
    }
    if (data.notes) {
        html += '<div style="margin-top:8px;padding:6px 8px;background:rgba(99,102,241,0.08);border-radius:5px;font-size:10px;color:#9ca3af;">' + esc(data.notes) + '</div>';
    }
    html += '</div>';
    el.innerHTML = html;
}
