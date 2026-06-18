// Full App JS Engine for 9-tab SLD QA/QC Web Suite

// Global State
let currentPDF = {
    doc: null,
    path: "",
    name: "",
    page: 0,
    zoom: 1.5,
    findings: [],
    sheets: [] // array of { pageNum, label, title, text, healthScore, findings }
};

let loadedPDFs = []; // array of document states: { doc, name, page, zoom, findings, sheets, userMarkups, calibrationScale, calibrationUnit }
let activePDFIndex = -1;

let activeView = "view-single";
let activeSubtab = "subtab-ids";
let activeDwgtab = "dwgtab-blocks";
let selectedFinding = null;

// // ─── STANDARD PRESETS (Indian IS/IEC & US NEC/NEMA) ─────────────────────────
const STANDARD_PRESETS = {
    'indian_is_iec': {
        name: '\u{1F1EE}\u{1F1F3} Indian (IS / IEC)',
        valid_voltage_levels: [
            '433V', '415V', '400V', '240V', '230V', '220V',
            '110V', '24VDC', '11kV', '22kV', '33kV', '66kV', '132kV'
        ],
        cable_sizes: [
            '1.0 sq mm', '1.5 sq mm', '2.5 sq mm', '4 sq mm',
            '6 sq mm', '10 sq mm', '16 sq mm', '25 sq mm',
            '35 sq mm', '50 sq mm', '70 sq mm', '95 sq mm',
            '120 sq mm', '150 sq mm', '185 sq mm', '240 sq mm',
            '300 sq mm', '400 sq mm', '500 sq mm', '630 sq mm'
        ],
        breaker_ratings: [
            '6', '10', '16', '20', '25', '32', '40', '50', '63',
            '80', '100', '125', '160', '200', '250', '315', '400',
            '500', '630', '800', '1000', '1250', '1600', '2000',
            '2500', '3150', '4000'
        ]
    },
    'us_nec': {
        name: '\u{1F1FA}\u{1F1F8} US (NEC / NEMA)',
        valid_voltage_levels: [
            '120VAC', '208VAC', '240VAC', '277VAC', '480VAC',
            '600VAC', '24VDC', '4.16kV', '13.8kV', '34.5kV'
        ],
        cable_sizes: [
            '14 AWG', '12 AWG', '10 AWG', '8 AWG', '6 AWG',
            '4 AWG', '3 AWG', '2 AWG', '1 AWG',
            '1/0 AWG', '2/0 AWG', '3/0 AWG', '4/0 AWG',
            '250 kcmil', '300 kcmil', '350 kcmil', '400 kcmil',
            '500 kcmil', '600 kcmil', '750 kcmil', '1000 kcmil'
        ],
        breaker_ratings: [
            '15', '20', '25', '30', '35', '40', '45', '50', '60',
            '70', '80', '90', '100', '110', '125', '150', '175',
            '200', '225', '250', '300', '350', '400', '450', '500',
            '600', '700', '800', '1000', '1200', '1600', '2000',
            '2500', '3000', '4000', '5000', '6000'
        ]
    }
};

// Profiles — default uses Indian IS/IEC standards
const DEFAULT_PROFILE = {
    name: "Default Profile",
    client_name: "Default Client",
    project_name: "Default Project",
    project_number: "00000",
    drawing_number_formats: [
        "^([A-Z]{1,4}-[A-Z]{2,4}-\\d{3,5}(?:[A-Z])?)$",
        "^([A-Z]{1,3}-\\d{3,5}(?:[A-Z])?)$"
    ],
    equipment_tag_patterns: [
        "\\b([A-Z]{1,4}-\\d+-\\d+)\\b",
        "\\b(CABLE\\s*#\\d+)\\b"
    ],
    valid_voltage_levels: [...STANDARD_PRESETS['indian_is_iec'].valid_voltage_levels],
    cable_sizes: [...STANDARD_PRESETS['indian_is_iec'].cable_sizes],
    breaker_ratings: [...STANDARD_PRESETS['indian_is_iec'].breaker_ratings]
};
let activeProfile = { ...DEFAULT_PROFILE };

// Compare state
let compareDocs = { A: null, B: null, page: 0, zoom: 1.0 };

// Vector Markups state
let userMarkups = []; // array of { type, page, color, width, points, text }
let activeMarkupTool = "NONE";
let currentDrawingMarkup = null;
let calibrationScale = null; // pixels per unit
let calibrationUnit = null;  // unit string
let currentViewport = null;  // PDF.js viewport for current page (used for coordinate transforms)

// Graph state
let graphNodes = [];
let graphEdges = [];
let isPhysicsSimulating = true;
let graphZoom = 1.0;
let graphPan = { x: 0, y: 0 };
let graphDraggedNode = null;
let graphHoveredNode = null;
let graphSelectedNode = null;
let graphLastMouse = { x: 0, y: 0 };
let graphSimTimer = null;
let graphInitialized = false;

// Initialize Web Suite
document.addEventListener('DOMContentLoaded', () => {
    initViewNavigation();
    initSingleReviewHandlers();
    initCompareHandlers();
    initProfileHandlers();
    initDXFHandlers();
    initSpecHandlers();
    initBatchHandlers();
    initPatternScannerHandlers();
    loadProfileList();
    
    // Wire up download report button
    document.getElementById('btn-report-download').addEventListener('click', exportReportToCSV);
});

// 1. PRIMARY VIEW CONTROLLER
function initViewNavigation() {
    document.querySelectorAll('.nav-item').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const targetView = btn.getAttribute('data-view');
            if (!targetView) return;

            document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');

            document.querySelectorAll('.view-panel').forEach(p => p.classList.add('hidden'));
            document.getElementById(targetView).classList.remove('hidden');

            activeView = targetView;
            setStatus(`Switched to: ${btn.innerText.trim()}`);

            // Initialize or stop physics simulation
            if (activeView === 'view-graph') {
                initGraphCanvas();
            } else {
                cancelAnimationFrame(graphSimTimer);
            }

            // Auto-trigger pattern scanning on entering view-scanner
            if (activeView === 'view-scanner' && currentPDF.doc) {
                const runScannerBtn = document.getElementById('btn-run-scanner');
                if (runScannerBtn) runScannerBtn.click();
            }
        });
    });
}

// 2. VIEW 1: SINGLE REVIEW ENGINE
function initSingleReviewHandlers() {
    const dropzone = document.getElementById('single-dropzone');
    const fileInput = document.getElementById('single-file-input');
    const clearBtn = document.getElementById('single-file-clear');

    dropzone.addEventListener('click', (e) => {
        if (e.target === fileInput) return;
        fileInput.value = '';
        fileInput.click();
    });
    fileInput.addEventListener('click', (e) => {
        e.stopPropagation();
    });
    fileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) loadSinglePDF(e.target.files[0]);
    });
    
    // Drag & Drop
    dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.style.borderColor = 'var(--accent)'; });
    dropzone.addEventListener('dragleave', () => { dropzone.style.borderColor = 'var(--border-color)'; });
    dropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropzone.style.borderColor = 'var(--border-color)';
        if (e.dataTransfer.files.length > 0) loadSinglePDF(e.dataTransfer.files[0]);
    });

    clearBtn.addEventListener('click', () => {
        resetSingleView();
    });

    // Subtabs Switch
    document.querySelectorAll('[data-subtab]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            document.querySelectorAll('[data-subtab]').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            
            const target = btn.getAttribute('data-subtab');
            document.querySelectorAll('.sub-tab-content').forEach(c => c.classList.add('hidden'));
            document.getElementById(target).classList.remove('hidden');
            activeSubtab = target;
            
            // Trigger Inspector extraction when switching to Inspector tab
            if (target === 'subtab-inspector' && currentPDF.doc) {
                runExtractionInspection(currentPDF.doc, currentPDF.page);
            }
        });
    });

    // Page controls
    document.getElementById('btn-prev-page').addEventListener('click', () => {
        if (currentPDF.doc && currentPDF.page > 0) {
            currentPDF.page--;
            renderPage();
        }
    });
    document.getElementById('btn-next-page').addEventListener('click', () => {
        if (currentPDF.doc && currentPDF.page < currentPDF.doc.numPages - 1) {
            currentPDF.page++;
            renderPage();
        }
    });

    // Zoom controls
    document.getElementById('btn-zoom-in').addEventListener('click', () => {
        if (currentPDF.zoom < 8.0) {
            currentPDF.zoom += (currentPDF.zoom >= 3.0 ? 0.5 : 0.25);
            renderPage();
        }
    });
    document.getElementById('btn-zoom-out').addEventListener('click', () => {
        if (currentPDF.zoom > 0.5) {
            currentPDF.zoom -= (currentPDF.zoom > 3.0 ? 0.5 : 0.25);
            renderPage();
        }
    });

    

    // Markup Toolbar selector
    document.querySelectorAll('.markup-tool').forEach(btn => {
        btn.addEventListener('click', (e) => {
            document.querySelectorAll('.markup-tool').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            activeMarkupTool = btn.getAttribute('data-tool');
            setStatus(`Active Tool: ${activeMarkupTool}`);
        });
    });

    document.getElementById('btn-undo-markup').addEventListener('click', () => {
        let lastIdx = -1;
        for (let i = userMarkups.length - 1; i >= 0; i--) {
            if (userMarkups[i].page === currentPDF.page) {
                lastIdx = i;
                break;
            }
        }
        if (lastIdx !== -1) {
            userMarkups.splice(lastIdx, 1);
            drawUserMarkups();
            saveSessionState();
            setStatus('Last markup on current page undone.');
        } else {
            setStatus('No markups to undo on this page.');
        }
    });

    document.getElementById('btn-clear-markups').addEventListener('click', () => {
        if (confirm('Clear custom user annotations on this page?')) {
            userMarkups = userMarkups.filter(m => m.page !== currentPDF.page);
            drawUserMarkups();
            saveSessionState();
            setStatus('Annotations on current page cleared.');
        }
    });

    document.getElementById('btn-commit-markups').addEventListener('click', exportFlattenedPDF);

    // Add tab open button handler
    const addTabBtn = document.getElementById('btn-add-pdf-tab');
    if (addTabBtn) {
        addTabBtn.addEventListener('click', () => {
            document.getElementById('single-file-input').click();
        });
    }

    // Layer checkboxes handlers
    const layers = ['layer-elec', 'layer-geom', 'layer-format', 'layer-xref', 'layer-ident', 'layer-comments', 'layer-user'];
    layers.forEach(id => {
        const cb = document.getElementById(id);
        if (cb) {
            cb.addEventListener('change', () => {
                rebuildChecklists();
                drawUserMarkups();
            });
        }
    });

    // Context Markup Canvas Mouse Events
    const mCanvas = document.getElementById('markup-canvas');
    mCanvas.addEventListener('mousedown', onMarkupMouseDown);
    mCanvas.addEventListener('mousemove', onMarkupMouseMove);
    mCanvas.addEventListener('mouseup', onMarkupMouseUp);

    // Approve & Reject buttons
    document.getElementById('btn-approve-finding').addEventListener('click', () => {
        approveSelectedFinding();
    });
    document.getElementById('btn-reject-finding').addEventListener('click', () => {
        rejectSelectedFinding();
    });

    // Suppress button
    document.getElementById('btn-suppress-finding').addEventListener('click', () => {
        suppressSelectedFinding();
    });

    // Keydown bindings
    window.addEventListener('keydown', (e) => {
        if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA' || document.activeElement.tagName === 'SELECT') {
            return;
        }
        if (e.key === 'y' || e.key === 'Y') {
            approveSelectedFinding();
        } else if (e.key === 'r' || e.key === 'R') {
            rejectSelectedFinding();
        }
    });

    // Right click context menu on canvas
    mCanvas.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showCustomContextMenu(e);
    });

    document.addEventListener('click', () => {
        const menu = document.getElementById('custom-canvas-menu');
        if (menu) menu.classList.add('hidden');
    });

    // Toggle Finding Details Panel
    const toggleHeader = document.getElementById('toggle-detail-panel');
    if (toggleHeader) {
        toggleHeader.addEventListener('click', () => {
            const panel = toggleHeader.closest('.detail-panel');
            if (panel) {
                panel.classList.toggle('collapsed');
            }
        });
    }
}

function saveSessionState() {
    if (!currentPDF.name) return;
    const sessionData = {
        userMarkups: userMarkups,
        findings: currentPDF.findings.map(f => ({
            page: f.page,
            severity: f.severity,
            category: f.category,
            description: f.description,
            expected: f.expected,
            found: f.found,
            suggestion: f.suggestion,
            status: f.status,
            isTarget: f.isTarget,
            targetPage: f.targetPage
        })),
        calibrationScale: calibrationScale,
        calibrationUnit: calibrationUnit
    };
    localStorage.setItem(`SLD_SESSION_${currentPDF.name}`, JSON.stringify(sessionData));
}

function renderPDFTabsBar() {
    const bar = document.getElementById('document-tabs-bar');
    if (!bar) return;
    
    // Clear old tab elements except the "+ Open PDF" button
    const tabs = bar.querySelectorAll('.doc-tab');
    tabs.forEach(t => t.remove());
    
    const addBtn = document.getElementById('btn-add-pdf-tab');
    
    loadedPDFs.forEach((pdf, index) => {
        const tab = document.createElement('div');
        tab.className = `doc-tab ${index === activePDFIndex ? 'active' : ''}`;
        tab.innerHTML = `
            <span class="tab-name" title="${pdf.name}">${pdf.name}</span>
            <button class="btn-close-tab" type="button">✖</button>
        `;
        tab.addEventListener('click', () => switchToPDFTab(index));
        tab.querySelector('.btn-close-tab').addEventListener('click', (e) => closePDFTab(index, e));
        
        bar.insertBefore(tab, addBtn);
    });
}

function switchToPDFTab(index) {
    if (index < 0 || index >= loadedPDFs.length) return;
    
    // Save current state first
    if (activePDFIndex !== -1 && loadedPDFs[activePDFIndex]) {
        loadedPDFs[activePDFIndex].page = currentPDF.page;
        loadedPDFs[activePDFIndex].zoom = currentPDF.zoom;
        loadedPDFs[activePDFIndex].findings = currentPDF.findings;
        loadedPDFs[activePDFIndex].sheets = currentPDF.sheets;
        loadedPDFs[activePDFIndex].userMarkups = userMarkups;
        loadedPDFs[activePDFIndex].calibrationScale = calibrationScale;
        loadedPDFs[activePDFIndex].calibrationUnit = calibrationUnit;
    }
    
    activePDFIndex = index;
    const target = loadedPDFs[index];
    
    currentPDF = {
        doc: target.doc,
        path: target.path,
        name: target.name,
        page: target.page,
        zoom: target.zoom,
        findings: target.findings,
        sheets: target.sheets
    };
    userMarkups = target.userMarkups || [];
    calibrationScale = target.calibrationScale;
    calibrationUnit = target.calibrationUnit;
    
    // Update UI
    renderPDFTabsBar();
    
    // Update all 3 filename labels
    document.getElementById('single-filename').innerText = target.name;
    document.getElementById('scanner-filename').innerText = target.name;
    document.getElementById('verification-filename').innerText = target.name;
    
    // Toggle dropzones and badges in all 3 views
    document.getElementById('single-dropzone').classList.add('hidden');
    document.getElementById('single-file-badge').classList.remove('hidden');
    
    document.getElementById('scanner-dropzone').classList.add('hidden');
    document.getElementById('scanner-file-badge').classList.remove('hidden');
    
    document.getElementById('verification-dropzone').classList.add('hidden');
    document.getElementById('verification-file-badge').classList.remove('hidden');
    
    renderPage();
    runSingleQAQCEngine(true); // skip checks calculation since we already have them!
    setStatus(`Switched to drawing: ${target.name}`);
}

function closePDFTab(index, e) {
    if (e) e.stopPropagation();
    if (index < 0 || index >= loadedPDFs.length) return;
    
    loadedPDFs.splice(index, 1);
    
    if (loadedPDFs.length === 0) {
        activePDFIndex = -1;
        resetSingleView();
    } else {
        if (activePDFIndex >= loadedPDFs.length) {
            activePDFIndex = loadedPDFs.length - 1;
        }
        switchToPDFTab(activePDFIndex);
    }
}

function resetSingleView() {
    loadedPDFs = [];
    activePDFIndex = -1;
    currentPDF = { doc: null, path: "", name: "", page: 0, zoom: 1.5, findings: [], sheets: [] };
    userMarkups = [];
    calibrationScale = null;
    calibrationUnit = null;

    const canvas = document.getElementById('pdf-canvas');
    const mCanvas = document.getElementById('markup-canvas');
    const ctx = canvas.getContext('2d');
    const mCtx = mCanvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    mCtx.clearRect(0, 0, mCanvas.width, mCanvas.height);
    
    document.getElementById('single-score-num').innerText = '--';
    document.getElementById('single-score-bar').style.width = '0%';
    document.getElementById('page-num-display').innerText = 'Page - / -';
    
    document.getElementById('ids-scan-results').innerHTML = '<p class="empty-text">No parsed labels.</p>';
    document.getElementById('identity-tree').innerHTML = '<p class="empty-text">No findings.</p>';
    document.getElementById('electrical-tree').innerHTML = '<p class="empty-text">No findings.</p>';
    document.getElementById('finding-detail-text').innerText = 'Select a finding to view suggestions.';
    document.getElementById('btn-suppress-finding').classList.add('hidden');
    document.getElementById('finding-actions-container').classList.add('hidden');
    
    // Update review progress bar
    document.getElementById('review-progress-text').innerText = "Reviewed: 0 / 0 (0%)";
    document.getElementById('review-progress-bar').style.width = "0%";
    
    // Update all 3 badges/dropzones
    document.getElementById('single-file-badge').classList.add('hidden');
    document.getElementById('single-dropzone').classList.remove('hidden');
    
    document.getElementById('scanner-file-badge').classList.add('hidden');
    document.getElementById('scanner-dropzone').classList.remove('hidden');
    
    document.getElementById('verification-file-badge').classList.add('hidden');
    document.getElementById('verification-dropzone').classList.remove('hidden');
    
    document.getElementById('single-filename').innerText = '-';
    document.getElementById('scanner-filename').innerText = '-';
    document.getElementById('verification-filename').innerText = '-';
    
    // Reset file input elements to allow re-loading the same file
    const f1 = document.getElementById('single-file-input');
    if (f1) f1.value = '';
    const f2 = document.getElementById('scanner-file-input');
    if (f2) f2.value = '';
    const f3 = document.getElementById('verification-file-input');
    if (f3) f3.value = '';
    
    // Hide extraction warning banner
    const warnBanner = document.getElementById('text-extraction-warning');
    if (warnBanner) warnBanner.classList.add('hidden');
    
    // Reset secondary result displays
    document.getElementById('scanner-table-body').innerHTML = '<tr><td colspan="4" class="empty-state">No scanner results. Enter a pattern and click Scan.</td></tr>';
    document.getElementById('spec-results-body').innerHTML = '<tr><td colspan="4" class="empty-state">No specifications loaded. Upload spec file and run audit.</td></tr>';
    
    renderPDFTabsBar();
}

async function loadSinglePDF(file) {
    if (!file || !file.name.endsWith('.pdf')) {
        alert('Please select a valid PDF file.');
        return;
    }
    
    // Save current active state before loading new one
    if (activePDFIndex !== -1 && loadedPDFs[activePDFIndex]) {
        loadedPDFs[activePDFIndex].page = currentPDF.page;
        loadedPDFs[activePDFIndex].zoom = currentPDF.zoom;
        loadedPDFs[activePDFIndex].findings = currentPDF.findings;
        loadedPDFs[activePDFIndex].sheets = currentPDF.sheets;
        loadedPDFs[activePDFIndex].userMarkups = userMarkups;
        loadedPDFs[activePDFIndex].calibrationScale = calibrationScale;
        loadedPDFs[activePDFIndex].calibrationUnit = calibrationUnit;
    }
    
    // Check if already loaded in tabs
    const existingIdx = loadedPDFs.findIndex(p => p.name === file.name);
    if (existingIdx !== -1) {
        switchToPDFTab(existingIdx);
        return;
    }
    
    setStatus('Loading PDF...');
    
    const fileReader = new FileReader();
    fileReader.onload = async function() {
        try {
            const typedarray = new Uint8Array(this.result);
            const doc = await pdfjsLib.getDocument({data: typedarray}).promise;
            
            // Extract PDF metadata (title, creator, keywords)
            const metadata = await extractPDFMetadata(doc, file);
            
            // Extract pages text client-side using robust multi-method extraction
            const sheets = [];
            let totalTextLength = 0;
            for (let i = 1; i <= doc.numPages; i++) {
                const page = await doc.getPage(i);
                const text = await extractPageTextRobust(page);
                totalTextLength += text.length;
                
                // Get page label from text, metadata, or filename
                let label = `Pg ${i}`;
                const m = text.match(/\b([A-Z]{1,2}-SLD-\d{3})\b/i);
                if (m) label = m[1];
                else if (metadata.title && doc.numPages === 1) label = metadata.filename.substring(0, 20);
                
                // Detect page title
                let title = 'Power Layout';
                if (text.includes('DISTRIBUTION') || metadata.title.toUpperCase().includes('DISTRIBUTION') ||
                    file.name.toUpperCase().includes('DISTRIBUTION')) {
                    title = 'Main Distribution Scheme';
                }
                
                sheets.push({
                    pageNum: i - 1,
                    label: label,
                    title: title,
                    text: text,
                    healthScore: 100,
                    findings: []
                });
            }
            
            // Auto-detect and select/create profile using the first page
            let fileProfile = activeProfile;
            if (sheets.length > 0) {
                autoDetectAndCreateProfile(sheets[0].text);
                fileProfile = activeProfile;
            }
            
            // Run text-based checks + structural checks using the correct auto-detected profile
            const textFindings = runChecksOnSheets(sheets, fileProfile);
            const structuralFindings = runStructuralChecks(doc, file, sheets, metadata, totalTextLength, fileProfile);
            const findings = [...textFindings, ...structuralFindings];
            
            // Show extraction warning if text is sparse
            showExtractionWarning(totalTextLength, file.name);
            
            // Create tab state and add to list
            const newState = {
                doc: doc,
                path: "",
                name: file.name,
                page: 0,
                zoom: 1.5,
                findings: findings,
                sheets: sheets,
                userMarkups: [],
                calibrationScale: null,
                calibrationUnit: null
            };
            
            // Restore session if exists
            const stored = localStorage.getItem(`SLD_SESSION_${file.name}`);
            if (stored) {
                try {
                    const sessionData = JSON.parse(stored);
                    newState.userMarkups = sessionData.userMarkups || [];
                    newState.calibrationScale = sessionData.calibrationScale || null;
                    newState.calibrationUnit = sessionData.calibrationUnit || null;
                    
                    // Match restored findings state
                    if (sessionData.findings) {
                        sessionData.findings.forEach(sf => {
                            const match = newState.findings.find(f => f.page === sf.page && f.description === sf.description);
                            if (match) {
                                match.status = sf.status;
                            }
                        });
                    }
                } catch(e) {
                    console.error("Error restoring session:", e);
                }
            }
            
            loadedPDFs.push(newState);
            

            
            switchToPDFTab(loadedPDFs.length - 1);
        } catch (err) {
            alert('Error loading PDF: ' + err.message);
        }
    };
    fileReader.readAsArrayBuffer(file);
}

async function renderPage() {
    if (!currentPDF.doc) return;
    
    const pageNum = currentPDF.page;
    const page = await currentPDF.doc.getPage(pageNum + 1);
    
    const canvas = document.getElementById('pdf-canvas');
    const mCanvas = document.getElementById('markup-canvas');
    const ctx = canvas.getContext('2d');
    
    // High-DPI supersampling: render at devicePixelRatio × zoom for crisp text
    const dpr = window.devicePixelRatio || 1;
    const viewport = page.getViewport({scale: currentPDF.zoom * dpr});
    currentViewport = viewport; // Store for Inspector coordinate transform
    
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    mCanvas.width = viewport.width;
    mCanvas.height = viewport.height;
    
    // CSS dimensions at logical zoom (canvas buffer is dpr× larger for crispness)
    const cssW = viewport.width / dpr;
    const cssH = viewport.height / dpr;
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';
    mCanvas.style.width = cssW + 'px';
    mCanvas.style.height = cssH + 'px';
    
    document.getElementById('zoom-value').innerText = Math.round(currentPDF.zoom * 100) + '%';
    document.getElementById('page-num-display').innerText = `Page ${pageNum + 1} of ${currentPDF.doc.numPages}`;
    
    const renderContext = {
        canvasContext: ctx,
        viewport: viewport
    };
    
    await page.render(renderContext).promise;
    
    // Draw vector annotations
    drawUserMarkups();
    
    // Update Inspector panel if it's visible (lazy — non-blocking)
    if (activeSubtab === 'subtab-inspector') {
        runExtractionInspection(currentPDF.doc, pageNum);
    }
}

// Draw user annotations overlays
function drawUserMarkups() {
    const mCanvas = document.getElementById('markup-canvas');
    const ctx = mCanvas.getContext('2d');
    ctx.clearRect(0, 0, mCanvas.width, mCanvas.height);
    
    // Filter layer check
    const showUser = document.getElementById('layer-user').checked;
    if (!showUser) return;
    
    userMarkups.forEach(m => {
        if (m.page !== currentPDF.page) return;
        
        ctx.strokeStyle = m.color;
        ctx.fillStyle = m.color;
        ctx.lineWidth = m.width;
        ctx.font = "14px Arial";
        
        if (m.type === 'PEN' && m.points.length > 1) {
            ctx.beginPath();
            ctx.moveTo(m.points[0].x, m.points[0].y);
            for (let i = 1; i < m.points.length; i++) {
                ctx.lineTo(m.points[i].x, m.points[i].y);
            }
            ctx.stroke();
        } else if (m.type === 'LINE' && m.points.length === 2) {
            ctx.beginPath();
            ctx.moveTo(m.points[0].x, m.points[0].y);
            ctx.lineTo(m.points[1].x, m.points[1].y);
            ctx.stroke();
        } else if (m.type === 'ARROW' && m.points.length === 2) {
            const p1 = m.points[0];
            const p2 = m.points[1];
            ctx.beginPath();
            ctx.moveTo(p1.x, p1.y);
            ctx.lineTo(p2.x, p2.y);
            ctx.stroke();
            
            // arrowhead
            const angle = Math.atan2(p2.y - p1.y, p2.x - p1.x);
            ctx.beginPath();
            ctx.moveTo(p2.x, p2.y);
            ctx.lineTo(p2.x - 12 * Math.cos(angle - Math.PI/6), p2.y - 12 * Math.sin(angle - Math.PI/6));
            ctx.lineTo(p2.x - 12 * Math.cos(angle + Math.PI/6), p2.y - 12 * Math.sin(angle + Math.PI/6));
            ctx.closePath();
            ctx.fill();
        } else if (m.type === 'RECTANGLE' && m.points.length === 2) {
            const x = Math.min(m.points[0].x, m.points[1].x);
            const y = Math.min(m.points[0].y, m.points[1].y);
            const w = Math.abs(m.points[0].x - m.points[1].x);
            const h = Math.abs(m.points[0].y - m.points[1].y);
            ctx.strokeRect(x, y, w, h);
        } else if (m.type === 'OVAL' && m.points.length === 2) {
            const x = Math.min(m.points[0].x, m.points[1].x);
            const y = Math.min(m.points[0].y, m.points[1].y);
            const w = Math.abs(m.points[0].x - m.points[1].x);
            const h = Math.abs(m.points[0].y - m.points[1].y);
            ctx.beginPath();
            ctx.ellipse(x + w/2, y + h/2, w/2, h/2, 0, 0, 2 * Math.PI);
            ctx.stroke();
        } else if (m.type === 'HIGHLIGHT' && m.points.length === 2) {
            const x = Math.min(m.points[0].x, m.points[1].x);
            const y = Math.min(m.points[0].y, m.points[1].y);
            const w = Math.abs(m.points[0].x - m.points[1].x);
            const h = Math.abs(m.points[0].y - m.points[1].y);
            ctx.save();
            ctx.globalAlpha = 0.3;
            ctx.fillStyle = m.color;
            ctx.fillRect(x, y, w, h);
            ctx.restore();
        } else if (m.type === 'CLOUD' && m.points.length > 2) {
            ctx.beginPath();
            ctx.moveTo(m.points[0].x, m.points[0].y);
            for (let i = 1; i < m.points.length; i++) {
                // draw cloudy arcs
                const p1 = m.points[i-1];
                const p2 = m.points[i];
                const mx = (p1.x + p2.x)/2;
                const my = (p1.y + p2.y)/2;
                ctx.quadraticCurveTo(mx + (p2.y - p1.y)*0.2, my - (p2.x - p1.x)*0.2, p2.x, p2.y);
            }
            ctx.closePath();
            ctx.stroke();
        } else if (m.type === 'TEXT_BOX' && m.points.length > 0) {
            ctx.strokeRect(m.points[0].x, m.points[0].y, 140, 40);
            ctx.fillStyle = "#ffffff";
            ctx.fillRect(m.points[0].x + 1, m.points[0].y + 1, 138, 38);
            ctx.fillStyle = m.color;
            ctx.fillText(m.text || "Text Box", m.points[0].x + 8, m.points[0].y + 24);
        } else if (m.type === 'CALLOUT' && m.points.length === 2) {
            const p1 = m.points[0];
            const p2 = m.points[1];
            
            // Line
            ctx.beginPath();
            ctx.moveTo(p1.x, p1.y);
            ctx.lineTo(p2.x, p2.y);
            ctx.stroke();
            
            // Text box at end
            ctx.strokeRect(p2.x, p2.y - 15, 140, 40);
            ctx.fillStyle = "#ffffff";
            ctx.fillRect(p2.x + 1, p2.y - 14, 138, 38);
            ctx.fillStyle = m.color;
            ctx.fillText(m.text || "Callout", p2.x + 8, p2.y + 10);
        } else if (m.type === 'MEASURE' && m.points.length === 2) {
            const p1 = m.points[0];
            const p2 = m.points[1];
            
            // Line
            ctx.beginPath();
            ctx.moveTo(p1.x, p1.y);
            ctx.lineTo(p2.x, p2.y);
            ctx.stroke();
            
            // Ticks
            const dx = p2.x - p1.x;
            const dy = p2.y - p1.y;
            const len = Math.sqrt(dx*dx + dy*dy);
            if (len > 0) {
                const nx = -dy / len;
                const ny = dx / len;
                const tick = 8;
                ctx.beginPath();
                ctx.moveTo(p1.x - nx * tick, p1.y - ny * tick);
                ctx.lineTo(p1.x + nx * tick, p1.y + ny * tick);
                ctx.moveTo(p2.x - nx * tick, p2.y - ny * tick);
                ctx.lineTo(p2.x + nx * tick, p2.y + ny * tick);
                ctx.stroke();
            }
            
            // Label
            const mx = (p1.x + p2.x) / 2;
            const my = (p1.y + p2.y) / 2;
            const text = m.text || "0.00";
            
            ctx.save();
            ctx.font = "bold 12px Arial";
            const tw = ctx.measureText(text).width;
            const boxW = tw + 10;
            const boxH = 18;
            
            ctx.fillStyle = "#ffffff";
            ctx.fillRect(mx - boxW / 2, my - boxH / 2, boxW, boxH);
            ctx.strokeRect(mx - boxW / 2, my - boxH / 2, boxW, boxH);
            
            ctx.fillStyle = m.color;
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(text, mx, my);
            ctx.restore();
        }
    });
}

function onMarkupMouseDown(e) {
    if (activeMarkupTool === 'NONE') return;
    
    const rect = e.target.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const x = (e.clientX - rect.left) * dpr;
    const y = (e.clientY - rect.top) * dpr;
    
    const color = document.getElementById('markup-color').value;
    const width = parseInt(document.getElementById('markup-width').value, 10);
    
    currentDrawingMarkup = {
        type: activeMarkupTool,
        page: currentPDF.page,
        color: color,
        width: width * dpr,
        points: [{x, y}]
    };
}

function onMarkupMouseMove(e) {
    if (!currentDrawingMarkup) return;
    
    const rect = e.target.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const x = (e.clientX - rect.left) * dpr;
    const y = (e.clientY - rect.top) * dpr;
    
    if (currentDrawingMarkup.type === 'PEN' || currentDrawingMarkup.type === 'CLOUD') {
        currentDrawingMarkup.points.push({x, y});
    } else {
        if (currentDrawingMarkup.points.length > 1) {
            currentDrawingMarkup.points[1] = {x, y};
        } else {
            currentDrawingMarkup.points.push({x, y});
        }
    }
    
    // Draw preview
    drawUserMarkups();
    
    // Render current one
    const mCanvas = document.getElementById('markup-canvas');
    const ctx = mCanvas.getContext('2d');
    ctx.strokeStyle = currentDrawingMarkup.color;
    ctx.lineWidth = currentDrawingMarkup.width;
    
    if (currentDrawingMarkup.type === 'PEN' && currentDrawingMarkup.points.length > 1) {
        ctx.beginPath();
        ctx.moveTo(currentDrawingMarkup.points[0].x, currentDrawingMarkup.points[0].y);
        for (let i = 1; i < currentDrawingMarkup.points.length; i++) {
            ctx.lineTo(currentDrawingMarkup.points[i].x, currentDrawingMarkup.points[i].y);
        }
        ctx.stroke();
    } else if ((currentDrawingMarkup.type === 'LINE' || currentDrawingMarkup.type === 'CALIBRATE' || currentDrawingMarkup.type === 'MEASURE') && currentDrawingMarkup.points.length === 2) {
        const p1 = currentDrawingMarkup.points[0];
        const p2 = currentDrawingMarkup.points[1];
        
        ctx.save();
        if (currentDrawingMarkup.type === 'CALIBRATE' || currentDrawingMarkup.type === 'MEASURE') {
            ctx.setLineDash([6, 4]);
        }
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.stroke();
        ctx.restore();
        
        if (currentDrawingMarkup.type === 'CALIBRATE' || currentDrawingMarkup.type === 'MEASURE') {
            const dx = p2.x - p1.x;
            const dy = p2.y - p1.y;
            const dist = Math.sqrt(dx*dx + dy*dy);
            
            // Ticks
            if (currentDrawingMarkup.type === 'MEASURE' && dist > 0) {
                ctx.save();
                ctx.strokeStyle = currentDrawingMarkup.color;
                ctx.lineWidth = currentDrawingMarkup.width;
                const nx = -dy / dist;
                const ny = dx / dist;
                const tick = 8;
                ctx.beginPath();
                ctx.moveTo(p1.x - nx * tick, p1.y - ny * tick);
                ctx.lineTo(p1.x + nx * tick, p1.y + ny * tick);
                ctx.moveTo(p2.x - nx * tick, p2.y - ny * tick);
                ctx.lineTo(p2.x + nx * tick, p2.y + ny * tick);
                ctx.stroke();
                ctx.restore();
            }
            
            // Text Box
            let txt = "";
            if (currentDrawingMarkup.type === 'CALIBRATE') {
                txt = "Calibrating: " + dist.toFixed(0) + " px";
            } else {
                if (calibrationScale) {
                    txt = (dist / calibrationScale).toFixed(2) + " " + calibrationUnit;
                } else {
                    txt = dist.toFixed(0) + " px";
                }
            }
            
            const mx = (p1.x + p2.x) / 2;
            const my = (p1.y + p2.y) / 2;
            
            ctx.save();
            ctx.font = "bold 12px Arial";
            const tw = ctx.measureText(txt).width;
            const boxW = tw + 10;
            const boxH = 18;
            
            ctx.fillStyle = "#ffffff";
            ctx.fillRect(mx - boxW / 2, my - boxH / 2, boxW, boxH);
            ctx.strokeRect(mx - boxW / 2, my - boxH / 2, boxW, boxH);
            
            ctx.fillStyle = currentDrawingMarkup.color;
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(txt, mx, my);
            ctx.restore();
        }
    } else if (currentDrawingMarkup.type === 'RECTANGLE' && currentDrawingMarkup.points.length === 2) {
        ctx.strokeRect(currentDrawingMarkup.points[0].x, currentDrawingMarkup.points[0].y, 
                       currentDrawingMarkup.points[1].x - currentDrawingMarkup.points[0].x, 
                       currentDrawingMarkup.points[1].y - currentDrawingMarkup.points[0].y);
    }
}

function onMarkupMouseUp(e) {
    if (!currentDrawingMarkup) return;
    
    if (currentDrawingMarkup.type === 'TEXT_BOX' || currentDrawingMarkup.type === 'CALLOUT') {
        const textVal = prompt('Enter annotation text:', 'Markup Notes');
        if (textVal) {
            currentDrawingMarkup.text = textVal;
            userMarkups.push(currentDrawingMarkup);
        }
    } else if (currentDrawingMarkup.type === 'CALIBRATE') {
        const p1 = currentDrawingMarkup.points[0];
        const p2 = currentDrawingMarkup.points[currentDrawingMarkup.points.length - 1];
        if (p1 && p2) {
            const dist = Math.sqrt((p2.x - p1.x)**2 + (p2.y - p1.y)**2);
            if (dist > 1) {
                const distanceStr = prompt("Enter real-world distance for this line (e.g. 10.5):", "10");
                if (distanceStr) {
                    const realD = parseFloat(distanceStr);
                    if (!isNaN(realD) && realD > 0) {
                        const unitStr = prompt("Enter unit (e.g. m, mm, ft, in):", "m") || "units";
                        calibrationScale = dist / realD;
                        calibrationUnit = unitStr;
                        setStatus(`Scale calibrated: 1 ${unitStr} = ${calibrationScale.toFixed(2)} px`);
                    } else {
                        alert("Invalid distance. Calibration aborted.");
                    }
                }
            }
        }
        document.querySelectorAll('.markup-tool').forEach(b => b.classList.remove('active'));
        const ptrBtn = document.querySelector('.markup-tool[data-tool="NONE"]');
        if (ptrBtn) ptrBtn.classList.add('active');
        activeMarkupTool = "NONE";
    } else if (currentDrawingMarkup.type === 'MEASURE') {
        const p1 = currentDrawingMarkup.points[0];
        const p2 = currentDrawingMarkup.points[currentDrawingMarkup.points.length - 1];
        if (p1 && p2) {
            const dist = Math.sqrt((p2.x - p1.x)**2 + (p2.y - p1.y)**2);
            if (dist > 1) {
                let scale = calibrationScale;
                let unit = calibrationUnit;
                if (!scale) {
                    const setupCal = confirm("Scale not calibrated. Would you like to calibrate the scale first?");
                    if (setupCal) {
                        document.querySelectorAll('.markup-tool').forEach(b => b.classList.remove('active'));
                        const calBtn = document.querySelector('.markup-tool[data-tool="CALIBRATE"]');
                        if (calBtn) calBtn.classList.add('active');
                        activeMarkupTool = "CALIBRATE";
                        currentDrawingMarkup = null;
                        drawUserMarkups();
                        return;
                    } else {
                        scale = 1.0;
                        unit = "px";
                    }
                }
                
                const realDist = dist / scale;
                currentDrawingMarkup.text = realDist.toFixed(2) + " " + unit;
                userMarkups.push(currentDrawingMarkup);
            }
        }
    } else {
        userMarkups.push(currentDrawingMarkup);
    }
    
    currentDrawingMarkup = null;
    drawUserMarkups();
    saveSessionState();
}

function exportFlattenedPDF() {
    if (!currentPDF.doc) return;
    
    // Capture canvas
    const canvas = document.getElementById('pdf-canvas');
    const mCanvas = document.getElementById('markup-canvas');
    
    // Create merge canvas
    const merge = document.createElement('canvas');
    merge.width = canvas.width;
    merge.height = canvas.height;
    const ctx = merge.getContext('2d');
    
    ctx.drawImage(canvas, 0, 0);
    ctx.drawImage(mCanvas, 0, 0);
    
    const dataUrl = merge.toDataURL('image/png');
    const link = document.createElement('a');
    link.href = dataUrl;
    link.download = `Annotated_Sheet_${currentPDF.page + 1}.png`;
    link.click();
    setStatus('Annotated sheet exported successfully as PNG.');
}

// 4. Run QA/QC Consistency checks engine
function runChecksOnSheets(sheets, profile = activeProfile) {
    const findings = [];
    const phase = "DD_CD";
    
    sheets.forEach((s, idx) => {
        // Check TBD
        const tbdKeywords = ["TBD", "TBC", "TBA", "XYZ"];
        tbdKeywords.forEach(kw => {
            if (s.text.toUpperCase().includes(kw)) {
                findings.push({
                    page: idx,
                    severity: "Minor",
                    category: "Drawing Identity",
                    description: `Placeholder '${kw}' found in sheet text`,
                    expected: "Resolved spec value",
                    found: kw,
                    suggestion: "Provide approved vendor details instead of placeholder"
                });
            }
        });
        
        // Check Drawing Number Format
        if (profile.drawing_number_formats && profile.drawing_number_formats.length > 0) {
            let matchedFormat = false;
            for (const fmt of profile.drawing_number_formats) {
                try {
                    const rx = new RegExp(fmt, 'i');
                    if (rx.test(s.label)) {
                        matchedFormat = true;
                        break;
                    }
                } catch (e) {
                    console.error("Invalid drawing format regex:", fmt, e);
                }
            }
            if (!matchedFormat && s.label && !s.label.startsWith('Pg')) {
                findings.push({
                    page: idx,
                    severity: "Major",
                    category: "Drawing Identity",
                    description: `Drawing sheet number '${s.label}' does not conform to any project format rules`,
                    expected: `Conforms to formats: ${profile.drawing_number_formats.join(' OR ')}`,
                    found: s.label,
                    suggestion: "Verify sheet numbering formatting matches client standards."
                });
            }
        }
        
        // Check Equipment Tags consistency
        if (profile.equipment_tag_patterns && profile.equipment_tag_patterns.length > 0) {
            const generalTagRegex = /\b([A-Z0-9]{2,6}-[A-Z0-9]{2,6}-\d{2,4})\b/g;
            let tagMatch;
            while ((tagMatch = generalTagRegex.exec(s.text)) !== null) {
                const tagStr = tagMatch[0];
                let matchesPattern = false;
                for (const pat of profile.equipment_tag_patterns) {
                    try {
                        const rx = new RegExp(pat);
                        if (rx.test(tagStr)) {
                            matchesPattern = true;
                            break;
                        }
                    } catch (e) {}
                }
                if (!matchesPattern) {
                    findings.push({
                        page: idx,
                        severity: "Minor",
                        category: "SLD Electrical",
                        description: `Equipment tag-like string '${tagStr}' does not match any profile standard tag patterns`,
                        expected: `Format matches: ${profile.equipment_tag_patterns.join(' OR ')}`,
                        found: tagStr,
                        suggestion: "Update drawing tag name or expand project standards profile patterns."
                    });
                }
            }
        }
        
        // Check Voltages
        let voltageMismatch = false;
        profile.valid_voltage_levels.forEach(v => {
            if (s.text.includes(v) && s.text.includes("4160V")) {
                voltageMismatch = true;
            }
        });
        if (voltageMismatch) {
            findings.push({
                page: idx,
                severity: "Major",
                category: "SLD Electrical",
                description: "Voltage level mismatch on single-line bus connections",
                expected: "Consistent 480VAC bus routing",
                found: "4160VAC voltage detected",
                suggestion: "Verify voltage rating or bus transformer step-down connections"
            });
        }

        // Check Cable Sizes
        if (profile.cable_sizes && profile.cable_sizes.length > 0) {
            const normStdCables = new Set(profile.cable_sizes.map(normalizeCableSizeJS));
            
            // AWG matches
            const awgRegex = /(?:#\s*([1-4]\/0|\d{1,2})\b(?:\s*(?:AWG|awg))?|\b([1-4]\/0|\d+)\s*(?:AWG|awg)\b)/ig;
            let match;
            while ((match = awgRegex.exec(s.text)) !== null) {
                const val = match[1] || match[2];
                if (val) {
                    const norm = val.toLowerCase() + "awg";
                    if (!normStdCables.has(norm)) {
                        findings.push({
                            page: idx,
                            severity: "Minor",
                            category: "SLD Electrical",
                            description: `Cable size '${match[0]}' is non-standard under the active profile`,
                            expected: `One of standard sizes: ${profile.cable_sizes.slice(0, 8).join(', ')}...`,
                            found: match[0],
                            suggestion: `Verify cable size or update project standards profile.`
                        });
                    }
                }
            }

            // Metric matches
            const metricRegex = /\b(\d+(?:\.\d+)?)\s*(?:sq\s*mm|mm2|mm²|sqmm)\b/ig;
            while ((match = metricRegex.exec(s.text)) !== null) {
                const val = match[1];
                const norm = val + "sqmm";
                if (!normStdCables.has(norm)) {
                    findings.push({
                        page: idx,
                        severity: "Minor",
                        category: "SLD Electrical",
                        description: `Cable size '${match[0]}' is non-standard under the active profile`,
                        expected: `One of standard sizes: ${profile.cable_sizes.slice(0, 8).join(', ')}...`,
                        found: match[0],
                        suggestion: `Verify cable size or update project standards profile.`
                    });
                }
            }

            // kcmil matches
            const kcmilRegex = /\b(\d+)\s*(?:kcmil|mcm)\b/ig;
            while ((match = kcmilRegex.exec(s.text)) !== null) {
                const val = match[1];
                const norm = val + "kcmil";
                if (!normStdCables.has(norm)) {
                    findings.push({
                        page: idx,
                        severity: "Minor",
                        category: "SLD Electrical",
                        description: `Cable size '${match[0]}' is non-standard under the active profile`,
                        expected: `One of standard sizes: ${profile.cable_sizes.slice(0, 8).join(', ')}...`,
                        found: match[0],
                        suggestion: `Verify cable size or update project standards profile.`
                    });
                }
            }
        }

        // Check Breakers
        if (profile.breaker_ratings && profile.breaker_ratings.length > 0) {
            const stdNums = new Set();
            profile.breaker_ratings.forEach(r => {
                const numMatch = r.match(/(\d+)/);
                if (numMatch) stdNums.add(parseInt(numMatch[1], 10));
            });

            const breakerRegex = /\b(\d+)\s*(?:AMP|A|Amp|Amps|AMPS)\b/ig;
            let match;
            while ((match = breakerRegex.exec(s.text)) !== null) {
                const matchedStr = match[0];
                const valStr = match[1];
                const val = parseInt(valStr, 10);
                
                if (val <= 5) continue;
                
                const startIdx = match.index;
                if (startIdx > 0 && s.text[startIdx - 1] === '/') continue;
                const endIdx = startIdx + matchedStr.length;
                if (endIdx < s.text.length && s.text[endIdx] === '/') continue;

                const surrounding = s.text.substring(Math.max(0, startIdx - 30), Math.min(s.text.length, endIdx + 30)).toUpperCase();
                if (surrounding.includes("FUSE") || surrounding.includes("CT") || surrounding.includes("CURRENT TRANSFORMER") || surrounding.includes("CONTROL") || surrounding.includes("RATIO") || surrounding.includes("PT")) {
                    continue;
                }

                if (!stdNums.has(val)) {
                    findings.push({
                        page: idx,
                        severity: "Minor",
                        category: "SLD Electrical",
                        description: `Circuit breaker rating '${matchedStr}' is non-standard under the active profile`,
                        expected: `One of standard ratings: ${profile.breaker_ratings.slice(0, 10).join(', ')}...`,
                        found: matchedStr,
                        suggestion: `Verify breaker rating or update project standards profile.`
                    });
                }
            }
        }
        
        // Check references
        const refRegex = /SEE\s*(?:SHEET)?\s*(\d+)\b/ig;
        let m;
        while ((m = refRegex.exec(s.text)) !== null) {
            const target = parseInt(m[1], 10);
            if (target > 0 && target <= sheets.length) {
                findings.push({
                    page: idx,
                    severity: "Valid",
                    category: "Cross-Reference",
                    description: `Valid cross-reference to Sheet ${target}`,
                    expected: "", found: "", suggestion: "",
                    isTarget: true,
                    targetPage: target - 1
                });
            } else {
                findings.push({
                    page: idx,
                    severity: "Major",
                    category: "Cross-Reference",
                    description: `Broken reference to Sheet ${target} (drawing set has only ${sheets.length} sheets)`,
                    expected: `Sheet between 1 and ${sheets.length}`,
                    found: `Sheet ${target}`,
                    suggestion: "Restore missing continuation sheet or fix link"
                });
            }
        }
    });

    // Apply Phase overrides
    findings.forEach(f => {
        if (phase === 'SD') {
            if (f.category === 'SLD Electrical' || f.category === 'Cross-Reference') {
                if (f.severity !== 'Valid') {
                    f.severity = 'Minor';
                    f.description = `[SD Phase Warning] ${f.description}`;
                }
            }
        } else if (phase === 'CA') {
            if (f.description.includes('RFI') || f.description.includes('Revision') || f.description.includes('Voltage')) {
                if (f.severity !== 'Valid') {
                    f.severity = 'Critical';
                    f.description = `[CA Phase Critical] ${f.description}`;
                }
            }
        }
    });

    return findings;
}

// Extract text content from PDF annotations (like AutoCAD SHX Text or comments)
async function extractAnnotationsText(page) {
    try {
        const annotations = await page.getAnnotations();
        if (!annotations || annotations.length === 0) {
            return '';
        }
        const annotTexts = [];
        annotations.forEach(annot => {
            const content = (annot.contentsObj ? annot.contentsObj.str : '') || annot.contents || '';
            if (content.trim()) {
                annotTexts.push(content);
            }
        });
        return annotTexts.join(' ').trim();
    } catch (e) {
        console.error("Error extracting page annotations:", e);
        return '';
    }
}

// ─── EXTRACTION INSPECTOR ENGINE ─────────────────────────────────────────────

// Auto-classify annotation text into categories
function classifyAnnotationText(text) {
    const t = text.toUpperCase().trim();
    const tags = [];
    if (/\d+\s*(?:SQ\s*MM|SQMM)|CABLE|XLPE|FLEXIBLE/i.test(t)) tags.push('cable');
    if (/MCCB|MCB|TPN|TP\+|DISCONNECTOR/i.test(t) || /^\d+A,/.test(t)) tags.push('breaker');
    if (/\bDB[-\s]|\bPANEL\b|\bUPS\b|\bLDB\b|\bRPDB\b/i.test(t)) tags.push('panel');
    if (/BMS|RS485|STATUS|INTERLOCK/i.test(t)) tags.push('bms');
    if (/CT\.\d+\/\d+A/i.test(t)) tags.push('ct');
    if (/EM\d{3,}|METER/i.test(t)) tags.push('meter');
    if (/\b(?:ZONE|AREA|ROOM|SCHOOL|ACCO[M]*ODATION|TRAINING|TRAING|HUB|OFFICE|BLOCK|FLOOR|BUILDING|WING|CENTER|CENTRE|HOUSE|SPARE|DINING|CANTEEN|KITCHEN|CAFETERIA|STP|PUMPS|LIGHTING)\b/i.test(t)) tags.push('zone');
    return tags;
}

// Group annotations by Y position with X-gap splitting and zone detection
async function groupAnnotationsByRow(page, yTolerance = 8) {
    try {
        const annotations = await page.getAnnotations();
        if (!annotations || annotations.length === 0) {
            return { rows: [], reviewerComments: [], stats: { total: 0, cables: 0, breakers: 0, panels: 0, bms: 0, cts: 0, meters: 0, zones: 0, reviewerComments: 0 }, pageWidth: 0, pageHeight: 0 };
        }

        // Get page dimensions at scale=1 for zone detection
        let pageWidth = 0, pageHeight = 0;
        try {
            const vp = page.getViewport({ scale: 1 });
            pageWidth = vp.width;
            pageHeight = vp.height;
        } catch (e) { /* ignore */ }

        // ── Separate reviewer comments (Text/FreeText sticky notes) ──────────────
        // These are engineer review notes like "Change the breaker to 63A TPN MCB"
        const REVIEW_SUBTYPES = ['Text', 'FreeText', 'Popup', 'Stamp'];
        const REVIEW_VERBS = ['CHANGE', 'REPLACE', 'ADD', 'REMOVE', 'INCORRECT', 'MISSING', 'REVISE', 'UPDATE', 'CHECK', 'VERIFY', 'NOTE:', 'COMMENT:'];

        const reviewerComments = [];
        const equipmentAnnots = [];

        annotations.forEach(annot => {
            const content = (annot.contentsObj ? annot.contentsObj.str : '') || annot.contents || annot.content || '';
            const subtype = annot.subtype || '';
            const isReviewComment = REVIEW_SUBTYPES.includes(subtype) ||
                REVIEW_VERBS.some(v => content.toUpperCase().includes(v));

            if (isReviewComment && content.trim()) {
                const rect = annot.rect || [0, 0, 0, 0];
                reviewerComments.push({
                    text: content.trim(),
                    subtype,
                    x0: rect[0], y0: rect[1], x1: rect[2], y1: rect[3],
                    author: (annot.titleObj ? annot.titleObj.str : '') || annot.title || ''
                });
            } else {
                equipmentAnnots.push(annot);
            }
        });

        const rowMap = {};
        const stats = { total: 0, cables: 0, breakers: 0, panels: 0, bms: 0, cts: 0, meters: 0, zones: 0, reviewerComments: reviewerComments.length };

        equipmentAnnots.forEach(annot => {
            const content = (annot.contentsObj ? annot.contentsObj.str : '') || annot.contents || '';
            if (!content.trim()) return;

            const rect = annot.rect || [0, 0, 0, 0];
            const yCenter = (rect[1] + rect[3]) / 2;

            // Find existing row within Y tolerance
            let matchedY = null;
            for (const existingY of Object.keys(rowMap)) {
                if (Math.abs(parseFloat(existingY) - yCenter) <= yTolerance) {
                    matchedY = existingY;
                    break;
                }
            }
            if (matchedY === null) matchedY = yCenter.toFixed(1);
            if (!rowMap[matchedY]) rowMap[matchedY] = [];

            const tags = classifyAnnotationText(content);
            rowMap[matchedY].push({
                text: content.trim(),
                x0: rect[0],
                y0: rect[1],
                x1: rect[2],
                y1: rect[3],
                tags: tags
            });

            stats.total++;
            if (tags.includes('cable')) stats.cables++;
            if (tags.includes('breaker')) stats.breakers++;
            if (tags.includes('panel')) stats.panels++;
            if (tags.includes('bms')) stats.bms++;
            if (tags.includes('ct')) stats.cts++;
            if (tags.includes('meter')) stats.meters++;
            if (tags.includes('zone')) stats.zones++;
        });

        // ── X-Gap Splitting ────────────────────────────────────────────────────
        // If items in the same Y-row are more than X_GAP_THRESHOLD apart in X,
        // they belong to different drawing zones and MUST NOT be merged.
        // Example: SLD panel labels (left) vs title block text (right).
        const X_GAP_THRESHOLD = 120; // PDF points (~42 mm) — adjust if needed

        // Title block zone heuristic:
        //   items whose average X > 62% of page width AND
        //   average Y (PDF bottom-origin) < 30% of page height
        //   are likely in the title block area.
        const TB_X_FRAC = 0.62;
        const TB_Y_FRAC = 0.30;

        const sortedKeys = Object.keys(rowMap).sort((a, b) => parseFloat(a) - parseFloat(b));
        const rows = [];

        sortedKeys.forEach(y => {
            const sorted = rowMap[y].sort((a, b) => a.x0 - b.x0);

            // Split into sub-groups by X gaps
            const subGroups = [[sorted[0]]];
            for (let i = 1; i < sorted.length; i++) {
                const lastItem = subGroups[subGroups.length - 1].slice(-1)[0];
                const gap = sorted[i].x0 - lastItem.x1;
                if (gap > X_GAP_THRESHOLD) {
                    subGroups.push([sorted[i]]);
                } else {
                    subGroups[subGroups.length - 1].push(sorted[i]);
                }
            }

            // Classify each sub-group into a zone
            subGroups.forEach(items => {
                let zone = 'drawing';
                if (pageWidth > 0 && pageHeight > 0) {
                    const avgX = items.reduce((s, i) => s + (i.x0 + i.x1) / 2, 0) / items.length;
                    const avgY = items.reduce((s, i) => s + (i.y0 + i.y1) / 2, 0) / items.length;
                    // PDF Y=0 at bottom — title block is bottom-right
                    if (avgX > pageWidth * TB_X_FRAC && avgY < pageHeight * TB_Y_FRAC) {
                        zone = 'title_block';
                    }
                }
                rows.push({ y: parseFloat(y), items, zone });
            });
        });

        return { rows, reviewerComments, stats, pageWidth, pageHeight };
    } catch (e) {
        console.error('Error grouping annotations:', e);
        return { rows: [], reviewerComments: [], stats: { total: 0, cables: 0, breakers: 0, panels: 0, bms: 0, cts: 0, meters: 0, reviewerComments: 0 }, pageWidth: 0, pageHeight: 0 };
    }
}

// Extract vector path statistics using PDF.js operator list
async function extractVectorPathStats(page) {
    try {
        const opList = await page.getOperatorList();
        const ops = opList.fnArray;
        const args = opList.argsArray;

        let totalPaths = 0;
        let strokeOps = 0;
        let fillOps = 0;
        let dashedPaths = 0;
        let currentDashPattern = [];

        // PDF.js OPS constants (dynamically loaded from pdfjsLib or using verified correct defaults)
        const OPS = (typeof pdfjsLib !== 'undefined' && pdfjsLib.OPS) || {};
        const OPS_constructPath = OPS.constructPath || 91;
        const OPS_setLineDash = OPS.setDash || 6;
        const OPS_stroke = OPS.stroke || 20;
        const OPS_closeStroke = OPS.closeStroke || 21;
        const OPS_fill = OPS.fill || 22;
        const OPS_eoFill = OPS.eoFill || 23;
        const OPS_fillStroke = OPS.fillStroke || 24;
        const OPS_eoFillStroke = OPS.eoFillStroke || 25;
        const OPS_closeFillStroke = OPS.closeFillStroke || 26;

        for (let i = 0; i < ops.length; i++) {
            const op = ops[i];
            if (op === OPS_setLineDash) {
                // args[i] = [dashArray, dashPhase]
                const dashArg = args[i];
                if (dashArg && dashArg[0] && Array.isArray(dashArg[0]) && dashArg[0].length > 0) {
                    currentDashPattern = dashArg[0];
                } else {
                    currentDashPattern = [];
                }
            } else if (op === OPS_constructPath) {
                totalPaths++;
                
                // Read the painting operator from constructPath's first argument
                const paintOp = args[i] && args[i][0];
                
                const isStroke = paintOp === OPS_stroke || 
                                 paintOp === OPS_closeStroke || 
                                 paintOp === OPS_fillStroke || 
                                 paintOp === OPS_eoFillStroke || 
                                 paintOp === OPS_closeFillStroke;
                                 
                const isFill = paintOp === OPS_fill || 
                               paintOp === OPS_eoFill || 
                               paintOp === OPS_fillStroke || 
                               paintOp === OPS_eoFillStroke || 
                               paintOp === OPS_closeFillStroke;
                               
                if (isStroke) {
                    strokeOps++;
                    if (currentDashPattern.length > 0) {
                        dashedPaths++;
                    }
                }
                if (isFill) {
                    fillOps++;
                }
            }
        }

        return {
            totalPaths,
            strokeOps,
            fillOps,
            dashedPaths,
            solidPaths: strokeOps - dashedPaths
        };
    } catch (e) {
        console.error("Error extracting vector path stats:", e);
        return { totalPaths: 0, strokeOps: 0, fillOps: 0, dashedPaths: 0, solidPaths: 0 };
    }
}

// Build and render the Inspector panel HTML
function buildInspectorPanel(inspectionData) {
    const panel = document.getElementById('inspector-panel');
    if (!panel) return;

    const { annotData, vectorStats, standardText, pageNum, rawAnnots } = inspectionData;
    const stats = annotData.stats;
    const reviewerComments = annotData.reviewerComments || [];

    const savedKey = localStorage.getItem('gemini_api_key') || '';
    const hasKey = savedKey.trim().length > 0;
    const savedModel = localStorage.getItem('gemini_model') || 'gemini-2.0-flash';
    let html = `
        <div class="inspector-section ai-section">
            <div class="inspector-section-header" onclick="toggleInspectorSection(this)">
                <span class="chevron ${hasKey ? '' : 'collapsed'}">▼</span>
                🤖 AI Identification (Gemini Vision)
                <span class="section-count" id="ai-status-badge">${hasKey ? 'Ready' : 'No Key'}</span>
            </div>
            <div class="inspector-section-body ${hasKey ? '' : 'collapsed'}" style="padding:10px;">
                <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:8px;">
                    <div style="display:flex;gap:6px;align-items:center;">
                        <input type="password" id="gemini-api-key-input"
                            placeholder="Paste Gemini API Key…"
                            value="${escapeHTML(savedKey)}"
                            oninput="localStorage.setItem('gemini_api_key', this.value); if (typeof refreshModelSelect === 'function') refreshModelSelect(this.value);"
                            class="compact-input" style="flex:1;">
                        <a href="https://aistudio.google.com/app/apikey" target="_blank"
                           style="font-size:10px;color:var(--accent-hover);white-space:nowrap;text-decoration:none;font-weight:600;">Get Key ↗</a>
                    </div>
                    <div style="display:flex;gap:6px;align-items:center;">
                        <span style="font-size:10px;color:var(--fg-dim);white-space:nowrap;">Model:</span>
                        <select id="gemini-model-select"
                            onchange="localStorage.setItem('gemini_model', this.value)"
                            class="compact-select" style="flex:1;">
                            <option value="gemini-1.5-flash" ${savedModel === 'gemini-1.5-flash' ? 'selected' : ''}>gemini-1.5-flash (Separate Free Quota)</option>
                            <option value="gemini-2.0-flash" ${savedModel === 'gemini-2.0-flash' ? 'selected' : ''}>gemini-2.0-flash (Default / Fast)</option>
                            <option value="gemini-2.5-flash" ${savedModel === 'gemini-2.5-flash' ? 'selected' : ''}>gemini-2.5-flash (Latest Flash)</option>
                            <option value="gemini-1.5-pro" ${savedModel === 'gemini-1.5-pro' ? 'selected' : ''}>gemini-1.5-pro (High Quality)</option>
                            <option value="gemini-2.0-pro-exp-02-05" ${savedModel === 'gemini-2.0-pro-exp-02-05' ? 'selected' : ''}>gemini-2.0-pro-exp (Max Accuracy)</option>
                        </select>
                    </div>
                </div>
                <button type="button" onclick="runAIPageAnalysis()"
                    id="btn-ai-analyze"
                    class="btn-ai-primary">
                    🤖 Identify All Elements on This Page
                </button>
                <button type="button" onclick="runAITopologyAnalysis()"
                    id="btn-ai-topology"
                    class="btn-ai-secondary">
                    ⚡ Analyze Topology (Incoming / Outgoing)
                </button>
                <div id="ai-analysis-results" style="margin-top:10px;"></div>
                <div id="ai-topology-results" style="margin-top:8px;"></div>
            </div>
        </div>
    `;

    // AI analysis is user-triggered only — click the button to prevent API quota waste

    // ── Stats Grid ──
    const rcCount = reviewerComments.length;
    html += `
        <div class="inspector-stats-grid">
            <div class="inspector-stat-card${rcCount > 0 ? ' stat-critical' : ''}">
                <span class="stat-icon">${rcCount > 0 ? '🔴' : '📝'}</span>
                <span class="stat-value">${rcCount > 0 ? rcCount : stats.total}</span>
                <span class="stat-label">${rcCount > 0 ? 'Review Comments' : 'Annotations'}</span>
            </div>
            <div class="inspector-stat-card">
                <span class="stat-icon">📐</span>
                <span class="stat-value">${vectorStats.totalPaths.toLocaleString()}</span>
                <span class="stat-label">Vector Paths</span>
            </div>
            <div class="inspector-stat-card">
                <span class="stat-icon">🔌</span>
                <span class="stat-value">${stats.cables}</span>
                <span class="stat-label">Cable Specs</span>
            </div>
            <div class="inspector-stat-card">
                <span class="stat-icon">⚡</span>
                <span class="stat-value">${stats.breakers}</span>
                <span class="stat-label">Breakers</span>
            </div>
            <div class="inspector-stat-card">
                <span class="stat-icon">🏗️</span>
                <span class="stat-value">${stats.panels}</span>
                <span class="stat-label">Panels / DBs</span>
            </div>
            <div class="inspector-stat-card">
                <span class="stat-icon">🗺️</span>
                <span class="stat-value">${stats.zones || 0}</span>
                <span class="stat-label">Zones / Areas</span>
            </div>
            <div class="inspector-stat-card">
                <span class="stat-icon">📡</span>
                <span class="stat-value">${stats.cts + stats.meters}</span>
                <span class="stat-label">CTs / Meters</span>
            </div>
            <div class="inspector-stat-card">
                <span class="stat-icon">⚙️</span>
                <span class="stat-value">${stats.bms}</span>
                <span class="stat-label">BMS / Control</span>
            </div>
        </div>
    `;

    // ── Reviewer Comments Section (shown FIRST, prominently if present) ──
    if (reviewerComments.length > 0) {
        html += `
            <div class="inspector-section" style="border-left:3px solid #ef4444;">
                <div class="inspector-section-header" onclick="toggleInspectorSection(this)">
                    <span class="chevron">▼</span>
                    📋 Review Comments
                    <span class="section-count" style="background:rgba(239,68,68,0.2);color:#ef4444;">${reviewerComments.length} issues</span>
                </div>
                <div class="inspector-section-body" style="padding:8px;">
        `;
        reviewerComments.forEach((rc, idx) => {
            const isChange = /change|replace|revise|incorrect/i.test(rc.text);
            const severity = isChange ? '#ef4444' : '#f59e0b';
            const icon = isChange ? '🔴' : '🟡';
            html += `
                <div class="review-comment-card" style="
                    border:1px solid ${severity}33;
                    background:${severity}11;
                    border-radius:6px;
                    padding:8px 10px;
                    margin-bottom:6px;
                    cursor:pointer;
                " onclick="locateInspectorAnnotation(${rc.x0},${rc.y0},${rc.x1},${rc.y1})">
                    <div style="display:flex;align-items:flex-start;gap:6px;">
                        <span style="font-size:13px;flex-shrink:0;">${icon}</span>
                        <div style="flex:1;">
                            <div style="font-size:11px;color:${severity};font-weight:600;line-height:1.4;">${escapeHTML(rc.text)}</div>
                            ${rc.author ? `<div style="font-size:10px;color:var(--fg-dim);margin-top:2px;">By: ${escapeHTML(rc.author)}</div>` : ''}
                        </div>
                        <span style="font-size:11px;color:var(--fg-dim);flex-shrink:0;">📍</span>
                    </div>
                </div>
            `;
        });
        html += `
                </div>
            </div>
        `;
    }

    // ── Annotation Rows: split by zone ──
    const drawingRows = annotData.rows.filter(r => r.zone !== 'title_block');
    const titleRows   = annotData.rows.filter(r => r.zone === 'title_block');
    const totalRows   = annotData.rows.length;

    // Helper: render a rows table
    function renderAnnotTable(rows) {
        if (rows.length === 0) return '<p class="empty-text" style="padding:12px;">No entries in this zone.</p>';
        let t = `<table class="inspector-table"><thead><tr><th>Y</th><th>#</th><th>Content</th></tr></thead><tbody>`;
        rows.forEach(row => {
            const rx0 = Math.min(...row.items.map(i => i.x0));
            const ry0 = Math.min(...row.items.map(i => i.y0));
            const rx1 = Math.max(...row.items.map(i => i.x1));
            const ry1 = Math.max(...row.items.map(i => i.y1));
            const itemsHtml = row.items.map(item => {
                let tagHtml = '';
                item.tags.forEach(tag => { tagHtml += `<span class="tag-badge ${tag}">${tag}</span>`; });
                return `${tagHtml}<span>${escapeHTML(item.text)}</span>`;
            }).join(' <span style="color:var(--fg-dim);">|</span> ');
            t += `<tr class="inspector-row-locatable" onclick="locateInspectorAnnotation(${rx0},${ry0},${rx1},${ry1})" title="Click to locate on drawing">
                <td class="y-col">${row.y.toFixed(0)}</td>
                <td class="count-col">${row.items.length}</td>
                <td class="text-col">${itemsHtml} <span class="locate-pin">📍</span></td>
            </tr>`;
        });
        t += `</tbody></table>`;
        return t;
    }

    html += `
        <div class="inspector-section">
            <div class="inspector-section-header" onclick="toggleInspectorSection(this)">
                <span class="chevron">▼</span>
                📋 Annotation Rows
                <span class="section-count">${totalRows} rows</span>
            </div>
            <div class="inspector-section-body">
                <!-- Search filter -->
                <div class="annot-search-bar">
                    <input type="text" id="annot-search-input" placeholder="🔍 Search annotations…"
                        oninput="filterAnnotRows(this.value)"
                        style="width:100%;padding:5px 8px;background:var(--bg-deep);border:1px solid var(--border-color);border-radius:4px;color:var(--fg-primary);font-size:11px;outline:none;">
                </div>

                <!-- Drawing Content zone -->
                <div class="annot-zone-header zone-drawing">
                    📐 Drawing Content &nbsp;<span class="section-count">${drawingRows.length}</span>
                </div>
                <div id="annot-zone-drawing">
                    ${renderAnnotTable(drawingRows)}
                </div>

                <!-- Title Block zone -->
                <div class="annot-zone-header zone-titleblock" style="margin-top:10px;">
                    🗂️ Title Block &nbsp;<span class="section-count">${titleRows.length}</span>
                </div>
                <div id="annot-zone-titleblock">
                    ${renderAnnotTable(titleRows)}
                </div>
            </div>
        </div>
    `;

    // ── Standard Text Section ──
    const textPreview = standardText ? standardText.substring(0, 500) : '(no standard text layer)';
    html += `
        <div class="inspector-section">
            <div class="inspector-section-header" onclick="toggleInspectorSection(this)">
                <span class="chevron">▼</span>
                📝 Standard Text Layer
                <span class="section-count">${standardText ? standardText.length : 0} chars</span>
            </div>
            <div class="inspector-section-body">
                <div class="inspector-text-block">${escapeHTML(textPreview)}${standardText && standardText.length > 500 ? '\n\n... (' + (standardText.length - 500) + ' more chars)' : ''}</div>
            </div>
        </div>
    `;

    // ── Vector Path Analysis Section ──
    const maxBar = Math.max(vectorStats.strokeOps, vectorStats.fillOps, vectorStats.dashedPaths, 1);
    html += `
        <div class="inspector-section">
            <div class="inspector-section-header" onclick="toggleInspectorSection(this)">
                <span class="chevron">▼</span>
                📐 Vector Path Analysis
                <span class="section-count">${vectorStats.totalPaths.toLocaleString()} paths</span>
            </div>
            <div class="inspector-section-body">
                <div class="inspector-path-bar">
                    <span class="bar-label">Strokes</span>
                    <div class="bar-track">
                        <div class="bar-fill stroke" style="width: ${Math.round((vectorStats.strokeOps / maxBar) * 100)}%"></div>
                    </div>
                    <span class="bar-value">${vectorStats.strokeOps.toLocaleString()}</span>
                </div>
                <div class="inspector-path-bar">
                    <span class="bar-label">Fills</span>
                    <div class="bar-track">
                        <div class="bar-fill fill" style="width: ${Math.round((vectorStats.fillOps / maxBar) * 100)}%"></div>
                    </div>
                    <span class="bar-value">${vectorStats.fillOps.toLocaleString()}</span>
                </div>
                <div class="inspector-path-bar">
                    <span class="bar-label">Dashed</span>
                    <div class="bar-track">
                        <div class="bar-fill dashed" style="width: ${vectorStats.dashedPaths > 0 ? Math.max(Math.round((vectorStats.dashedPaths / maxBar) * 100), 3) : 0}%"></div>
                    </div>
                    <span class="bar-value">${vectorStats.dashedPaths.toLocaleString()}</span>
                </div>
                <div style="padding: 6px 10px; font-size: 10px; color: var(--fg-dim);">
                    Solid strokes: ${vectorStats.solidPaths.toLocaleString()} ·
                    Dashed strokes: ${vectorStats.dashedPaths.toLocaleString()} ·
                    Fill operations: ${vectorStats.fillOps.toLocaleString()}
                </div>
            </div>
        </div>
    `;

    // ── Raw Annotations Diagnostic Section ──
    const rawCount = rawAnnots ? rawAnnots.length : 0;
    html += `
        <div class="inspector-section">
            <div class="inspector-section-header" onclick="toggleInspectorSection(this)">
                <span class="chevron">▼</span>
                🔧 Diagnostic: Raw Annotations
                <span class="section-count">${rawCount} items</span>
            </div>
            <div class="inspector-section-body" style="padding: 10px; font-size: 11px;">
                <div style="margin-bottom: 8px;">
                    <strong>PDF.js raw list length:</strong> ${rawCount}
                </div>
    `;

    if (rawAnnots && rawAnnots.length > 0) {
        html += `<div style="max-height: 180px; overflow-y: auto; font-family: monospace; background: rgba(0,0,0,0.3); padding: 8px; border-radius: 4px;">`;
        rawAnnots.slice(0, 15).forEach((ann, idx) => {
            const keys = Object.keys(ann);
            html += `
                <div style="border-bottom: 1px solid rgba(255,255,255,0.08); padding-bottom: 6px; margin-bottom: 6px; font-size: 10px;">
                    <strong>[${idx}] Subtype:</strong> ${ann.subtype || ann.type || 'unknown'}<br/>
                    <strong>Contents:</strong> "${escapeHTML((ann.contentsObj ? ann.contentsObj.str : '') || ann.contents || ann.content || '')}"<br/>
                    <strong>Title/Author:</strong> "${escapeHTML((ann.titleObj ? ann.titleObj.str : '') || ann.title || '')}"<br/>
                    <strong>Rect:</strong> ${JSON.stringify(ann.rect)}<br/>
                    <strong>Keys:</strong> ${keys.join(', ')}
                </div>
            `;
        });
        if (rawAnnots.length > 15) {
            html += `<div style="color: var(--fg-dim); text-align: center; margin-top: 4px;">... and ${rawAnnots.length - 15} more items ...</div>`;
        }
        html += `</div>`;
    } else {
        html += `<p class="empty-text" style="padding: 8px 0 0 0;">No raw annotations returned by page.getAnnotations().</p>`;
    }

    html += `
            </div>
        </div>
    `;

    panel.innerHTML = html;

    // Dynamically refresh model selector options based on key
    if (typeof refreshModelSelect === 'function') {
        refreshModelSelect(savedKey);
    }
}

// Toggle collapsible inspector section
function toggleInspectorSection(headerEl) {
    const body = headerEl.nextElementSibling;
    const chevron = headerEl.querySelector('.chevron');
    if (body.classList.contains('collapsed')) {
        body.classList.remove('collapsed');
        chevron.classList.remove('collapsed');
    } else {
        body.classList.add('collapsed');
        chevron.classList.add('collapsed');
    }
}

// Filter annotation rows by search text (searches across both Drawing and Title Block zones)
function filterAnnotRows(query) {
    const q = query.trim().toLowerCase();
    const rows = document.querySelectorAll('#annot-zone-drawing tr.inspector-row-locatable, #annot-zone-titleblock tr.inspector-row-locatable');
    rows.forEach(row => {
        const text = row.textContent.toLowerCase();
        row.style.display = (!q || text.includes(q)) ? '' : 'none';
    });
    // Update zone header counts to reflect visible rows
    ['annot-zone-drawing', 'annot-zone-titleblock'].forEach(zoneId => {
        const zoneEl = document.getElementById(zoneId);
        if (!zoneEl) return;
        const header = zoneEl.previousElementSibling;
        if (!header) return;
        const badge = header.querySelector('.section-count');
        if (!badge) return;
        const total = zoneEl.querySelectorAll('tr.inspector-row-locatable').length;
        const visible = zoneEl.querySelectorAll('tr.inspector-row-locatable:not([style*="display: none"])').length;
        badge.textContent = q ? `${visible} / ${total}` : `${total}`;
    });
}

// Helper to escape HTML
function escapeHTML(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// Locate and highlight an annotation on the PDF canvas
// pdfX0, pdfY0, pdfX1, pdfY1: coordinates as returned by PDF.js getAnnotations() rect array
// For AutoCAD-exported PDFs: these are in top-left origin screen space (no Y-flip needed)
function locateInspectorAnnotation(pdfX0, pdfY0, pdfX1, pdfY1) {
    if (!currentViewport) {
        setStatus('No page loaded to locate annotation.');
        return;
    }

    // Use viewport.convertToViewportRectangle() as the canonical PDF.js transform.
    // This handles rotation, scale, and coordinate origin correctly for all PDF types.
    let cx0, cy0, cx1, cy1;
    try {
        // PDF.js convertToViewportRectangle expects [x0, y0, x1, y1] in PDF user-space
        const rect = currentViewport.convertToViewportRectangle([pdfX0, pdfY0, pdfX1, pdfY1]);
        cx0 = rect[0];
        cy0 = rect[1];
        cx1 = rect[2];
        cy1 = rect[3];
    } catch(e) {
        console.error("Error in convertToViewportRectangle:", e);
        // Fallback: simple scale
        const scale = currentPDF.zoom;
        cx0 = pdfX0 * scale; cy0 = pdfY0 * scale;
        cx1 = pdfX1 * scale; cy1 = pdfY1 * scale;
    }

    // Normalize so top-left corner is always cx0, cy0
    if (cx1 < cx0) { const t = cx0; cx0 = cx1; cx1 = t; }
    if (cy1 < cy0) { const t = cy0; cy0 = cy1; cy1 = t; }

    const cw = cx1 - cx0;
    const ch = cy1 - cy0;

    // Scroll the canvas viewport to center the annotation (account for DPR)
    const scrollContainer = document.querySelector('.canvas-scroll-container');
    if (scrollContainer) {
        const dpr = window.devicePixelRatio || 1;
        const centerY = (cy0 + ch / 2) / dpr;
        const centerX = (cx0 + cw / 2) / dpr;
        const containerH = scrollContainer.clientHeight;
        const containerW = scrollContainer.clientWidth;
        scrollContainer.scrollTo({
            top: Math.max(0, centerY - containerH / 2),
            left: Math.max(0, centerX - containerW / 2),
            behavior: 'smooth'
        });
    }

    // Flash animated highlight rectangle on the markup canvas
    const mCanvas = document.getElementById('markup-canvas');
    if (!mCanvas) return;
    const mCtx = mCanvas.getContext('2d');

    let frame = 0;
    const totalFrames = 50; // ~1.7s at 30fps
    const padding = 8;

    // Cancel any running locate animation
    if (window._locateAnimTimer) cancelAnimationFrame(window._locateAnimTimer);

    function animateHighlight() {
        if (frame >= totalFrames) {
            // Restore normal markup canvas
            drawUserMarkups();
            setStatus('Annotation located on drawing.');
            return;
        }

        // Fade in for first half, fade out for second half
        const progress = frame / totalFrames;
        const opacity = progress < 0.5 ? (progress * 2) : (1 - (progress - 0.5) * 2);
        const pulse = 1 + Math.sin(frame * 0.3) * 0.04; // subtle size pulse

        mCtx.clearRect(0, 0, mCanvas.width, mCanvas.height);

        // Draw the normal user markups underneath
        const showUser = document.getElementById('layer-user') && document.getElementById('layer-user').checked;
        if (showUser) {
            userMarkups.forEach(m => {
                if (m.page !== currentPDF.page) return;
                // lightweight redraw for the existing markups omitted to keep this simple
            });
        }

        // Outer glow shadow
        mCtx.save();
        mCtx.shadowColor = 'rgba(255, 230, 0, 0.9)';
        mCtx.shadowBlur = 24 * pulse;
        mCtx.strokeStyle = `rgba(255, 230, 0, ${opacity})`;
        mCtx.lineWidth = 3;
        mCtx.setLineDash([]);

        const ox = cx0 - padding * pulse;
        const oy = cy0 - padding * pulse;
        const ow = cw + padding * 2 * pulse;
        const oh = ch + padding * 2 * pulse;

        // Filled semi-transparent region
        mCtx.fillStyle = `rgba(255, 230, 0, ${opacity * 0.15})`;
        mCtx.fillRect(ox, oy, ow, oh);

        // Animated dashed border
        mCtx.setLineDash([8, 4]);
        mCtx.lineDashOffset = -frame * 2;
        mCtx.strokeRect(ox, oy, ow, oh);

        // Corner markers
        mCtx.setLineDash([]);
        const cs = 12;
        mCtx.strokeStyle = `rgba(255, 80, 0, ${opacity})`;
        mCtx.lineWidth = 3;
        // top-left
        mCtx.beginPath(); mCtx.moveTo(ox, oy + cs); mCtx.lineTo(ox, oy); mCtx.lineTo(ox + cs, oy); mCtx.stroke();
        // top-right
        mCtx.beginPath(); mCtx.moveTo(ox + ow - cs, oy); mCtx.lineTo(ox + ow, oy); mCtx.lineTo(ox + ow, oy + cs); mCtx.stroke();
        // bottom-left
        mCtx.beginPath(); mCtx.moveTo(ox, oy + oh - cs); mCtx.lineTo(ox, oy + oh); mCtx.lineTo(ox + cs, oy + oh); mCtx.stroke();
        // bottom-right
        mCtx.beginPath(); mCtx.moveTo(ox + ow - cs, oy + oh); mCtx.lineTo(ox + ow, oy + oh); mCtx.lineTo(ox + ow, oy + oh - cs); mCtx.stroke();

        mCtx.restore();

        frame++;
        window._locateAnimTimer = requestAnimationFrame(animateHighlight);
    }

    animateHighlight();
    setStatus(`📍 Locating annotation at (${Math.round(pdfX0)}, ${Math.round(pdfY0)}) on drawing...`);
}


// Run full extraction inspection for the current page
async function runExtractionInspection(doc, pageIndex) {
    if (!doc) return;

    try {
        console.log(`Inspector: Running extraction inspection for page index ${pageIndex}...`);
        const page = await doc.getPage(pageIndex + 1);

        // Fetch raw annotations for debug section
        let rawAnnots = [];
        try {
            rawAnnots = await page.getAnnotations();
            console.log(`Inspector: page.getAnnotations() returned ${rawAnnots.length} items.`);
        } catch (err) {
            console.error("Inspector: Error calling page.getAnnotations():", err);
        }

        // Run extraction steps sequentially to be robust against concurrency issues
        const annotData = await groupAnnotationsByRow(page);
        const vectorStats = await extractVectorPathStats(page);
        const textContent = await page.getTextContent();

        const standardText = textContent.items
            .filter(item => item.str && item.str.trim())
            .map(item => item.str)
            .join(' ')
            .trim();

        // Save current page annotations and data globally for AI locator to use
        currentPDF.rawAnnots = rawAnnots;
        currentPDF.annotData = annotData;

        buildInspectorPanel({
            annotData,
            vectorStats,
            standardText,
            pageNum: pageIndex,
            rawAnnots
        });
    } catch (e) {
        console.error("Error running extraction inspection:", e);
        const panel = document.getElementById('inspector-panel');
        if (panel) panel.innerHTML = `<p class="empty-text">Error inspecting page: ${e.message}</p>`;
    }
}

// ─── MULTI-METHOD TEXT EXTRACTION ────────────────────────────────────────────
async function extractPageTextRobust(page) {
    let bestText = '';
    
    // Method A: Standard getTextContent
    try {
        const tc1 = await page.getTextContent();
        const text1 = tc1.items.map(item => item.str || '').join(' ').trim();
        if (text1.length > bestText.length) bestText = text1;
    } catch(e) {}
    
    // Method B: With markedContent flag (catches tagged/structured PDFs)
    try {
        const tc2 = await page.getTextContent({ includeMarkedContent: true });
        const text2 = tc2.items
            .filter(item => item.str !== undefined && item.str !== null)
            .map(item => item.str)
            .join(' ').trim();
        if (text2.length > bestText.length) bestText = text2;
    } catch(e) {}
    
    // Method C: Position-aware joining (adjacent items joined without space)
    // Helps CAD PDFs where '480' and 'VAC' are separate items but adjacent
    try {
        const tc3 = await page.getTextContent();
        const items = tc3.items.filter(it => it.str && it.str.trim());
        let text3 = '';
        for (let i = 0; i < items.length; i++) {
            const cur = items[i];
            const prev = items[i - 1];
            if (i === 0) {
                text3 = cur.str;
            } else {
                // Check horizontal gap between previous and current item
                const prevRight = prev.transform ? prev.transform[4] + (prev.width || 0) : 0;
                const curLeft = cur.transform ? cur.transform[4] : 0;
                const gap = curLeft - prevRight;
                text3 += (gap < 3 && gap > -50) ? cur.str : ' ' + cur.str;
            }
        }
        text3 = text3.trim();
        if (text3.length > bestText.length) bestText = text3;
    } catch(e) {}
    
    // Add annotation text (AutoCAD SHX text layer & reviewer comments)
    const annotText = await extractAnnotationsText(page);
    if (annotText.length > 0) {
        bestText += ' ' + annotText;
    }
    
    return bestText;
}

// ─── PDF METADATA EXTRACTION ─────────────────────────────────────────────────
async function extractPDFMetadata(doc, file) {
    const meta = { title: '', subject: '', author: '', keywords: '', creator: '', filename: '', sheetList: [] };
    meta.filename = file.name.replace(/\.pdf$/i, '');
    
    try {
        const result = await doc.getMetadata();
        if (result && result.info) {
            meta.title    = result.info.Title    || '';
            meta.subject  = result.info.Subject  || '';
            meta.author   = result.info.Author   || '';
            meta.keywords = result.info.Keywords || '';
            meta.creator  = result.info.Creator  || '';
        }
    } catch(e) {}
    
    try {
        const outline = await doc.getOutline();
        if (outline && outline.length > 0) {
            meta.sheetList = outline.map(item => item.title).filter(Boolean);
        }
    } catch(e) {}
    
    return meta;
}

// ─── STRUCTURAL CHECKS (no text required) ────────────────────────────────────
function runStructuralChecks(doc, file, sheets, metadata, totalTextLength, profile = activeProfile) {
    const findings = [];
    const filenameNoExt = file.name.replace(/\.pdf$/i, '');
    
    // 1. Drawing number format check on filename
    if (profile.drawing_number_formats && profile.drawing_number_formats.length > 0) {
        let matchedFormat = false;
        for (const fmt of profile.drawing_number_formats) {
            try {
                if (new RegExp(fmt, 'i').test(filenameNoExt)) { matchedFormat = true; break; }
            } catch(e) {}
        }
        if (!matchedFormat) {
            findings.push({
                page: 0, severity: 'Major', category: 'Drawing Identity',
                description: `Filename '${filenameNoExt}' does not conform to project drawing number format rules`,
                expected: `Matches format: ${profile.drawing_number_formats.slice(0,2).join(' OR ')}`,
                found: filenameNoExt,
                suggestion: 'Rename the file to follow the standard project drawing numbering format'
            });
        }
    }
    
    // 2. Page count check — single page SLD may be incomplete
    if (doc.numPages === 1) {
        findings.push({
            page: 0, severity: 'Minor', category: 'Drawing Identity',
            description: 'SLD drawing set contains only 1 page — verify drawing set is complete',
            expected: 'Multi-page drawing set or confirmed standalone sheet',
            found: '1 page only',
            suggestion: 'Confirm this is a standalone sheet, or check for missing continuation sheets'
        });
    }
    
    // 3. CAD tool detection from metadata
    if (metadata.creator) {
        const cadTools = ['AutoCAD', 'Revit', 'MicroStation', 'ETAP', 'SketchUp', 'SolidWorks'];
        const detectedTool = cadTools.find(t => metadata.creator.includes(t));
        if (detectedTool) {
            findings.push({
                page: 0, severity: 'Minor', category: 'Format',
                description: `PDF created with ${metadata.creator} — vector CAD PDF detected (limited text extraction)`,
                expected: 'Text-searchable PDF (PDF/A preferred for archival and QA review)',
                found: metadata.creator,
                suggestion: 'Enable "Publish to PDF" with text embedding, or export the DXF file and use the DWG/DXF tab for full analysis'
            });
        }
    }
    
    // 4. TBD in metadata title
    if (metadata.title && (metadata.title.toUpperCase().includes('TBD') || metadata.title.toUpperCase().includes('UNTITLED'))) {
        findings.push({
            page: 0, severity: 'Major', category: 'Drawing Identity',
            description: `PDF title metadata contains placeholder: "${metadata.title}"`,
            expected: 'Resolved project drawing title',
            found: metadata.title,
            suggestion: 'Update the drawing title in CAD before publishing to PDF'
        });
    }
    
    // 5. Very sparse text — flag as CAD vector content
    if (totalTextLength < 200 && totalTextLength >= 0) {
        findings.push({
            page: 0, severity: 'Major', category: 'Format',
            description: `PDF text extraction returned only ${totalTextLength} characters — most drawing content is vector-only`,
            expected: 'Text-searchable drawing content (> 200 characters extracted)',
            found: `${totalTextLength} characters across ${doc.numPages} page(s)`,
            suggestion: 'Export drawing with "PDF/A" or text-searchable option in your CAD application. Alternatively, export as DXF and use the DWG/DXF tab.'
        });
    }
    
    return findings;
}

// ─── EXTRACTION WARNING BANNER ───────────────────────────────────────────────
function showExtractionWarning(totalTextLength, filename) {
    const banner = document.getElementById('text-extraction-warning');
    if (!banner) return;
    
    if (totalTextLength < 200) {
        banner.innerHTML = `
            <span class="warn-icon">⚠️</span>
            <span class="warn-text">
                <strong>Limited text extracted (${totalTextLength} chars) from "${filename}".</strong>
                This is a vector-based CAD PDF — text-based QA checks are limited.
                Structural &amp; format findings are shown below. For full cable/tag analysis,
                export the DXF file and use the <strong>DWG/DXF tab</strong>.
            </span>
            <button class="warn-dismiss" onclick="this.parentElement.classList.add('hidden')">✖</button>
        `;
        banner.classList.remove('hidden');
    } else {
        banner.classList.add('hidden');
    }
}

function calculateHealthScoreFromFindings(findings, pageCount) {
    let pageScores = Array(pageCount).fill(100);
    
    findings.forEach(f => {
        if (f.status === 'approved') return; // approved findings do not deduct points
        let deduct = 0;
        if (f.severity === 'Critical') deduct = 15;
        else if (f.severity === 'Major') deduct = 8;
        else if (f.severity === 'Minor') deduct = 3;
        
        pageScores[f.page] -= deduct;
    });
    
    let sumScore = pageScores.reduce((acc, v) => acc + Math.max(0, v), 0);
    return Math.round(sumScore / pageCount);
}

function runSingleQAQCEngine(skipCalculation = false) {
    if (currentPDF.sheets.length === 0) return;
    
    if (!skipCalculation) {
        // Keep structural findings
        const structural = currentPDF.findings.filter(f => f.category === 'Format' || f.category === 'Drawing Identity');
        
        // Regenerate text-based findings using activeProfile
        const textFindings = runChecksOnSheets(currentPDF.sheets, activeProfile);
        
        currentPDF.findings = [...textFindings, ...structural];
    }
    
    const scoreAvg = calculateHealthScoreFromFindings(currentPDF.findings, currentPDF.sheets.length);
    
    // Check if this is a vector-only PDF (check if any Format finding about sparse text exists)
    const isSparseText = currentPDF.findings.some(f =>
        f.category === 'Format' && f.description && f.description.includes('text extraction returned only')
    );
    const hasOnlyStructural = currentPDF.findings.length > 0 && 
        currentPDF.findings.every(f => f.category === 'Format' || f.category === 'Drawing Identity') &&
        isSparseText;
    
    const scoreEl = document.getElementById('single-score-num');
    const barEl = document.getElementById('single-score-bar');
    
    if (isSparseText && currentPDF.findings.filter(f => f.severity === 'Critical' || f.severity === 'Major').length <= 2 && scoreAvg >= 90) {
        // Scores of 90+ from structural-only checks on a vector PDF are misleading — show N/A
        scoreEl.innerText = 'N/A';
        scoreEl.className = 'score-na';
        barEl.style.width = '30%';
        barEl.style.background = '#f59e0b';
    } else {
        scoreEl.innerText = scoreAvg;
        scoreEl.className = '';
        barEl.style.width = scoreAvg + '%';
        barEl.style.background = '';
    }
    
    // Rebuild checklists
    rebuildChecklists();
}

function rebuildChecklists() {
    const listIds = document.getElementById('ids-scan-results');
    const listIdent = document.getElementById('identity-tree');
    const listElec = document.getElementById('electrical-tree');
    
    listIds.innerHTML = "";
    listIdent.innerHTML = "";
    listElec.innerHTML = "";
    
    // Page IDs list
    currentPDF.sheets.forEach(s => {
        const div = document.createElement('div');
        div.className = "finding-item";
        div.innerHTML = `
            <div class="finding-title-row">
                <span class="page-lbl">Pg ${s.pageNum + 1}</span>
                <span class="cat">LABEL</span>
            </div>
            <div class="desc">${s.label} (${s.title})</div>
        `;
        div.onclick = () => { currentPDF.page = s.pageNum; renderPage(); };
        listIds.appendChild(div);
    });

    // Identity and Electrical
    const activeFindings = currentPDF.findings.filter(f => f.severity !== 'Valid');
    
    // Calculate and update review progress
    const totalActive = activeFindings.length;
    const reviewedCount = activeFindings.filter(f => f.status === 'approved' || f.status === 'rejected').length;
    const pct = totalActive > 0 ? Math.round((reviewedCount / totalActive) * 100) : 0;
    document.getElementById('review-progress-text').innerText = `Reviewed: ${reviewedCount} / ${totalActive} (${pct}%)`;
    document.getElementById('review-progress-bar').style.width = pct + '%';
    
    // Filter active findings for the sidebar view based on layer checkboxes
    const filteredFindings = activeFindings.filter(f => {
        if (f.category === 'Drawing Identity' && !document.getElementById('layer-ident').checked) return false;
        if (f.category === 'SLD Electrical' && !document.getElementById('layer-elec').checked) return false;
        if (f.category === 'Cross-Reference' && !document.getElementById('layer-xref').checked) return false;
        if (f.category === 'Geometry' && !document.getElementById('layer-geom').checked) return false;
        if (f.category === 'Format' && !document.getElementById('layer-format').checked) return false;
        if (f.category === 'Comments' && !document.getElementById('layer-comments').checked) return false;
        return true;
    });

    if (filteredFindings.length === 0) {
        listIdent.innerHTML = '<p class="empty-text">No findings.</p>';
        listElec.innerHTML = '<p class="empty-text">No findings.</p>';
    } else {
        filteredFindings.forEach(f => {
            const div = document.createElement('div');
            div.className = `finding-item ${f.status ? f.status : ''} ${selectedFinding === f ? 'active' : ''} ${f.category === 'Reviewer Comment' ? 'reviewer-comment-item' : ''}`;
            
            let badgeHtml = `<span class="badge ${f.severity.toLowerCase()}">${f.severity}</span>`;
            if (f.status === 'approved') {
                badgeHtml = `<span class="badge approved">Approved</span>`;
            } else if (f.status === 'rejected') {
                badgeHtml = `<span class="badge rejected">Rejected</span>`;
            }
            
            const locateBtn = f.annotRect ? `<span class="finding-locate-btn" onclick="event.stopPropagation();locateInspectorAnnotation(${f.annotRect[0]},${f.annotRect[1]},${f.annotRect[2]},${f.annotRect[3]})" title="Locate on drawing">📍 Locate</span>` : '';

            div.innerHTML = `
                <div class="finding-title-row">
                    <span class="page-lbl">Pg ${f.page + 1}</span>
                    ${badgeHtml}
                    ${locateBtn}
                </div>
                <div class="desc" style="${f.status === 'approved' ? 'text-decoration: line-through; opacity: 0.6;' : ''}">${f.description}</div>
                <div class="cat">${f.category}</div>
            `;
            div.onclick = () => {
                currentPDF.page = f.page;
                renderPage();
                selectFindingDetail(f, div);
                if (f.annotRect) {
                    setTimeout(() => {
                        if (typeof locateInspectorAnnotation === 'function')
                            locateInspectorAnnotation(f.annotRect[0], f.annotRect[1], f.annotRect[2], f.annotRect[3]);
                    }, 500);
                }
            };
            
            if (f.category === 'Reviewer Comment') {
                listElec.prepend(div);
            } else if (f.category === 'Drawing Identity') {
                listIdent.appendChild(div);
            } else {
                listElec.appendChild(div);
            }
        });
    }

    // Populate Report Viewer table
    const reportTbody = document.getElementById('report-table-body');
    if (reportTbody) {
        if (activeFindings.length === 0) {
            reportTbody.innerHTML = '<tr><td colspan="7" class="empty-state">No drawing results loaded. Run checks in Single Review first.</td></tr>';
        } else {
            let html = "";
            activeFindings.forEach(f => {
                let badgeClass = f.severity.toLowerCase();
                let rowStyle = f.status === 'approved' ? 'text-decoration: line-through; opacity: 0.6;' : '';
                html += `
                    <tr style="${rowStyle}; cursor: pointer;" class="report-row-clickable" data-page="${f.page}">
                        <td><strong>Pg ${f.page + 1}</strong></td>
                        <td><span class="badge ${badgeClass}">${f.severity}</span></td>
                        <td>${f.category}</td>
                        <td>${f.description}</td>
                        <td>${f.expected || '-'}</td>
                        <td class="text-danger">${f.found || '-'}</td>
                        <td>${f.suggestion || '-'}</td>
                    </tr>
                `;
            });
            reportTbody.innerHTML = html;
            
            // Add navigate-on-click to row click
            reportTbody.querySelectorAll('.report-row-clickable').forEach(row => {
                row.addEventListener('click', () => {
                    const page = parseInt(row.getAttribute('data-page'), 10);
                    currentPDF.page = page;
                    const singleReviewBtn = document.querySelector('.nav-item[data-view="view-single"]');
                    if (singleReviewBtn) singleReviewBtn.click();
                    renderPage();
                });
            });
        }
    }
}

function selectFindingDetail(finding, element) {
    selectedFinding = finding;
    document.querySelectorAll('.finding-item').forEach(el => el.classList.remove('active'));
    if (element) element.classList.add('active');
    
    let aiFix = "";
    if (finding.category === 'Drawing Identity') {
        aiFix = "AI suggested fix: Edit the drawing title block sheet properties to fill standard client / project metadata, and match filename revision.";
    } else if (finding.category === 'SLD Electrical') {
        aiFix = "AI suggested fix: Verify if voltage level or breaker size in project settings profile matches, or correct drawing label value to standard rating.";
    } else if (finding.category === 'Cross-Reference') {
        aiFix = "AI suggested fix: Restore missing sheet drawing or verify sheet continuation number matches drawing numbering series.";
    }
    
    let detailText = `Severity: ${finding.severity}\nArea: ${finding.category}\n\nDescription:\n${finding.description}\n\nExpected: ${finding.expected || 'N/A'}\nFound: ${finding.found || 'N/A'}\n\nRecommendation:\n${finding.suggestion || 'N/A'}`;
    if (aiFix) {
        detailText += `\n\n💡 ${aiFix}`;
    }
    document.getElementById('finding-detail-text').innerText = detailText;
    
    document.getElementById('btn-suppress-finding').classList.remove('hidden');
    document.getElementById('finding-actions-container').classList.remove('hidden');

    // Auto-expand detail panel if collapsed when selecting a finding
    const panel = document.querySelector('.detail-panel');
    if (panel) {
        panel.classList.remove('collapsed');
    }
}

function approveSelectedFinding() {
    if (!selectedFinding) return;
    selectedFinding.status = 'approved';
    runSingleQAQCEngine(true);
    saveSessionState();
    setStatus('Finding approved.');
    if (document.getElementById('chk-auto-advance').checked) {
        autoAdvanceFinding();
    }
}

function rejectSelectedFinding() {
    if (!selectedFinding) return;
    selectedFinding.status = 'rejected';
    runSingleQAQCEngine(true);
    saveSessionState();
    setStatus('Finding rejected.');
    if (document.getElementById('chk-auto-advance').checked) {
        autoAdvanceFinding();
    }
}

function autoAdvanceFinding() {
    const unreviewed = currentPDF.findings.find(f => f.severity !== 'Valid' && !f.status);
    if (unreviewed) {
        currentPDF.page = unreviewed.page;
        renderPage();
        
        rebuildChecklists();
        
        const items = document.querySelectorAll('.finding-item');
        let matchedEl = null;
        items.forEach(el => {
            if (el.textContent.includes(unreviewed.description)) {
                matchedEl = el;
            }
        });
        
        if (matchedEl) {
            selectFindingDetail(unreviewed, matchedEl);
            matchedEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
    }
}

function showCustomContextMenu(e) {
    const menu = document.getElementById('custom-canvas-menu');
    if (!menu) return;
    
    // Position menu
    menu.style.left = e.pageX + 'px';
    menu.style.top = e.pageY + 'px';
    
    let html = "";
    
    if (selectedFinding) {
        html += `
            <div class="custom-context-menu-item" onclick="approveSelectedFinding()">
                <span style="color: #10b981;">✓</span> Approve Selected Finding
            </div>
            <div class="custom-context-menu-item" onclick="rejectSelectedFinding()">
                <span style="color: #ef4444;">✗</span> Reject Selected Finding
            </div>
            <div class="custom-context-menu-item" onclick="suppressSelectedFinding()">
                <span style="color: #f59e0b;">⊘</span> Suppress Selected Finding
            </div>
            <div class="custom-context-menu-separator"></div>
        `;
    }
    
    const tools = [
        { name: "Pointer Mode", icon: "🖱️", tool: "NONE" },
        { name: "Add Text Box", icon: "T", tool: "TEXT_BOX" },
        { name: "Add Callout", icon: "💬", tool: "CALLOUT" },
        { name: "Add Arrow", icon: "➡", tool: "ARROW" },
        { name: "Add Revision Cloud", icon: "☁", tool: "CLOUD" },
        { name: "Calibrate Scale", icon: "📏", tool: "CALIBRATE" },
        { name: "Measure Length", icon: "📐", tool: "MEASURE" }
    ];
    
    tools.forEach(t => {
        html += `
            <div class="custom-context-menu-item" onclick="selectMarkupToolFromMenu('${t.tool}')">
                <span>${t.icon}</span> ${t.name}
            </div>
        `;
    });
    
    menu.innerHTML = html;
    menu.classList.remove('hidden');
}

window.selectMarkupToolFromMenu = function(tool) {
    activeMarkupTool = tool;
    document.querySelectorAll('.markup-tool').forEach(b => {
        b.classList.remove('active');
        if (b.getAttribute('data-tool') === tool) {
            b.classList.add('active');
        }
    });
    setStatus(`Active Tool: ${tool}`);
};

window.suppressSelectedFinding = function() {
    if (selectedFinding && confirm('Suppress this warning as a false positive?')) {
        currentPDF.findings = currentPDF.findings.filter(f => f !== selectedFinding);
        runSingleQAQCEngine(true);
        saveSessionState();
        setStatus('Finding suppressed.');
    }
};

window.approveSelectedFinding = approveSelectedFinding;
window.rejectSelectedFinding = rejectSelectedFinding;

// 3. VIEW 2: COMPARE PDF VIEWS ENGINE
function initCompareHandlers() {
    const fileA = document.getElementById('compare-file-a');
    const fileB = document.getElementById('compare-file-b');
    const compareBtn = document.getElementById('btn-run-compare');
    const modeSelect = document.getElementById('compare-mode');

    // Reset input elements on click to allow re-selection
    if (fileA) fileA.addEventListener('click', () => { fileA.value = ''; });
    if (fileB) fileB.addEventListener('click', () => { fileB.value = ''; });

    compareBtn.addEventListener('click', async () => {
        if (!fileA.files[0] || !fileB.files[0]) {
            alert('Please select both Drawing A and Drawing B PDFs.');
            return;
        }
        
        setStatus('Comparing drawing sets...');
        
        const docA = await loadCompareDoc(fileA.files[0]);
        const docB = await loadCompareDoc(fileB.files[0]);
        
        compareDocs.A = docA;
        compareDocs.B = docB;
        compareDocs.page = 0;
        
        const navGroup = document.getElementById('compare-nav-group');
        if (navGroup) navGroup.classList.remove('hidden');
        updateComparePageDisplay();
        
        renderCompareViews();
    });

    modeSelect.addEventListener('change', (e) => {
        const mode = e.target.value;
        if (mode === 'side-by-side') {
            document.getElementById('compare-sbs-view').classList.remove('hidden');
            document.getElementById('compare-overlay-view').classList.add('hidden');
        } else {
            document.getElementById('compare-sbs-view').classList.add('hidden');
            document.getElementById('compare-overlay-view').classList.remove('hidden');
        }
        renderCompareViews();
    });

    // Wire up navigation controls
    document.getElementById('btn-compare-prev').addEventListener('click', () => {
        if (compareDocs.page > 0) {
            compareDocs.page--;
            updateComparePageDisplay();
            renderCompareViews();
        }
    });
    
    document.getElementById('btn-compare-next').addEventListener('click', () => {
        const maxPages = Math.max(
            compareDocs.A ? compareDocs.A.numPages : 1,
            compareDocs.B ? compareDocs.B.numPages : 1
        );
        if (compareDocs.page < maxPages - 1) {
            compareDocs.page++;
            updateComparePageDisplay();
            renderCompareViews();
        }
    });
    
    document.getElementById('btn-compare-zoom-in').addEventListener('click', () => {
        if (compareDocs.zoom < 8.0) {
            compareDocs.zoom += (compareDocs.zoom >= 3.0 ? 0.5 : 0.25);
            updateComparePageDisplay();
            renderCompareViews();
        }
    });
    
    document.getElementById('btn-compare-zoom-out').addEventListener('click', () => {
        if (compareDocs.zoom > 0.5) {
            compareDocs.zoom -= (compareDocs.zoom > 3.0 ? 0.5 : 0.25);
            updateComparePageDisplay();
            renderCompareViews();
        }
    });

    // Synchronize scrolling
    const scrollA = document.getElementById('pane-scroll-a');
    const scrollB = document.getElementById('pane-scroll-b');
    
    scrollA.addEventListener('scroll', () => {
        scrollB.scrollTop = scrollA.scrollTop;
        scrollB.scrollLeft = scrollA.scrollLeft;
    });
    scrollB.addEventListener('scroll', () => {
        scrollA.scrollTop = scrollB.scrollTop;
        scrollA.scrollLeft = scrollB.scrollLeft;
    });
}

function updateComparePageDisplay() {
    const maxPages = Math.max(
        compareDocs.A ? compareDocs.A.numPages : 1,
        compareDocs.B ? compareDocs.B.numPages : 1
    );
    document.getElementById('compare-page-display').innerText = `Page ${compareDocs.page + 1} of ${maxPages}`;
    document.getElementById('compare-zoom-display').innerText = Math.round(compareDocs.zoom * 100) + '%';
}

function loadCompareDoc(file) {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = async function() {
            const typedarray = new Uint8Array(this.result);
            const doc = await pdfjsLib.getDocument({data: typedarray}).promise;
            resolve(doc);
        };
        reader.readAsArrayBuffer(file);
    });
}

async function renderCompareViews() {
    if (!compareDocs.A || !compareDocs.B) return;
    
    const pageNum = compareDocs.page;
    const mode = document.getElementById('compare-mode').value;
    
    if (mode === 'side-by-side') {
        const canvasA = document.getElementById('compare-canvas-a');
        const canvasB = document.getElementById('compare-canvas-b');
        
        await renderComparePage(compareDocs.A, pageNum, canvasA);
        await renderComparePage(compareDocs.B, pageNum, canvasB);
    } else {
        // Overlay visual diff shader
        const canvasA = document.createElement('canvas');
        const canvasB = document.createElement('canvas');
        
        await renderComparePage(compareDocs.A, pageNum, canvasA);
        await renderComparePage(compareDocs.B, pageNum, canvasB);
        
        const canvasDiff = document.getElementById('compare-canvas-diff');
        performVisualDiff(canvasA, canvasB, canvasDiff);
    }
}

async function renderComparePage(doc, pageNum, canvas) {
    const ctx = canvas.getContext('2d');
    if (!doc || pageNum >= doc.numPages) {
        canvas.width = 400;
        canvas.height = 500;
        ctx.fillStyle = '#101f42';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#8ea0c4';
        ctx.font = '13px Inter';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('[Page Not Present]', canvas.width / 2, canvas.height / 2);
        return;
    }
    const page = await doc.getPage(pageNum + 1);
    const viewport = page.getViewport({scale: compareDocs.zoom});
    
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    
    const renderContext = { canvasContext: ctx, viewport: viewport };
    await page.render(renderContext).promise;
}

function performVisualDiff(canvasA, canvasB, canvasDiff) {
    const W = Math.max(canvasA.width, canvasB.width) || 300;
    const H = Math.max(canvasA.height, canvasB.height) || 400;
    
    // Create temporary normalized canvases of matching dimensions
    const normA = document.createElement('canvas');
    normA.width = W;
    normA.height = H;
    const ctxNormA = normA.getContext('2d');
    ctxNormA.fillStyle = '#ffffff';
    ctxNormA.fillRect(0, 0, W, H);
    if (canvasA.width > 0 && canvasA.height > 0) {
        ctxNormA.drawImage(canvasA, 0, 0, W, H);
    }
    
    const normB = document.createElement('canvas');
    normB.width = W;
    normB.height = H;
    const ctxNormB = normB.getContext('2d');
    ctxNormB.fillStyle = '#ffffff';
    ctxNormB.fillRect(0, 0, W, H);
    if (canvasB.width > 0 && canvasB.height > 0) {
        ctxNormB.drawImage(canvasB, 0, 0, W, H);
    }
    
    const ctxDiff = canvasDiff.getContext('2d');
    canvasDiff.width = W;
    canvasDiff.height = H;
    
    const imgDataA = ctxNormA.getImageData(0, 0, W, H);
    const imgDataB = ctxNormB.getImageData(0, 0, W, H);
    const imgDataDiff = ctxDiff.createImageData(W, H);
    
    const dataA = imgDataA.data;
    const dataB = imgDataB.data;
    const dataDiff = imgDataDiff.data;
    
    for (let i = 0; i < dataA.length; i += 4) {
        const rA = dataA[i], gA = dataA[i+1], bA = dataA[i+2], aA = dataA[i+3];
        const rB = dataB[i], gB = dataB[i+1], bB = dataB[i+2], aB = dataB[i+3];
        
        const diff = Math.abs(rA - rB) + Math.abs(gA - gB) + Math.abs(bA - bB);
        
        if (diff > 40) {
            const valA = (rA + gA + bA) / 3;
            const valB = (rB + gB + bB) / 3;
            if (valB < valA) {
                // Added in B -> Green
                dataDiff[i] = 0;
                dataDiff[i+1] = 230; // Neon green
                dataDiff[i+2] = 118;
                dataDiff[i+3] = 255;
            } else {
                // Removed in A -> Red
                dataDiff[i] = 255; // Neon red
                dataDiff[i+1] = 23;
                dataDiff[i+2] = 68;
                dataDiff[i+3] = 255;
            }
        } else {
            // Same -> gray faded background
            const val = (rA + gA + bA) / 3;
            dataDiff[i] = val;
            dataDiff[i+1] = val;
            dataDiff[i+2] = val;
            dataDiff[i+3] = aA * 0.12;
        }
    }
    ctxDiff.putImageData(imgDataDiff, 0, 0);
}

// 4. VIEW 5: PROJECT PROFILES MANAGER
let allProfiles = [];
function initProfileHandlers() {
    document.getElementById('btn-save-profile').addEventListener('click', () => {
        const client = document.getElementById('prof-client').value;
        const project = document.getElementById('prof-project').value;
        const number = document.getElementById('prof-number').value;
        const voltages = document.getElementById('prof-voltages').value.split(',').map(s => s.trim());
        const cableSizes = document.getElementById('prof-cable-sizes').value.split('\n').map(s => s.trim()).filter(s => s.length > 0);
        const breakerRatings = document.getElementById('prof-breaker-ratings').value.split('\n').map(s => s.trim()).filter(s => s.length > 0);
        
        activeProfile.client_name = client;
        activeProfile.project_name = project;
        activeProfile.project_number = number;
        activeProfile.valid_voltage_levels = voltages;
        activeProfile.cable_sizes = cableSizes;
        activeProfile.breaker_ratings = breakerRatings;
        
        const idx = allProfiles.findIndex(p => p.project_name === project && p.client_name === client);
        if (idx !== -1) {
            allProfiles[idx] = { ...activeProfile };
        } else {
            allProfiles.push({ ...activeProfile });
        }
        
        localStorage.setItem('SLD_PROFILES', JSON.stringify(allProfiles));
        localStorage.setItem('SLD_ACTIVE_PROFILE', JSON.stringify(activeProfile));
        alert('Profile configuration saved successfully.');
        loadProfileList();
        
        if (currentPDF && currentPDF.doc) {
            runSingleQAQCEngine();
        }
    });

    document.getElementById('btn-add-profile').addEventListener('click', () => {
        const name = prompt("Enter new project name:", "New Project");
        if (!name) return;
        
        const newProf = {
            ...DEFAULT_PROFILE,
            project_name: name,
            client_name: "New Client",
            project_number: "00000"
        };
        allProfiles.push(newProf);
        activeProfile = newProf;
        localStorage.setItem('SLD_PROFILES', JSON.stringify(allProfiles));
        localStorage.setItem('SLD_ACTIVE_PROFILE', JSON.stringify(activeProfile));
        loadProfileList();
    });

    document.getElementById('btn-delete-profile').addEventListener('click', () => {
        if (allProfiles.length <= 1) {
            alert('Cannot delete the only remaining profile.');
            return;
        }
        if (confirm(`Are you sure you want to delete the profile "${activeProfile.project_name}"?`)) {
            const idx = allProfiles.findIndex(p => p.project_name === activeProfile.project_name && p.client_name === activeProfile.client_name);
            if (idx !== -1) {
                allProfiles.splice(idx, 1);
                activeProfile = { ...allProfiles[0] };
                localStorage.setItem('SLD_PROFILES', JSON.stringify(allProfiles));
                localStorage.setItem('SLD_ACTIVE_PROFILE', JSON.stringify(activeProfile));
                alert('Profile deleted successfully.');
                loadProfileList();
                if (currentPDF && currentPDF.doc) {
                    runSingleQAQCEngine();
                }
            }
        }
    });

    // Standard preset quick-load buttons
    document.getElementById('btn-preset-indian').addEventListener('click', () => {
        applyStandardPreset('indian_is_iec');
    });
    document.getElementById('btn-preset-us').addEventListener('click', () => {
        applyStandardPreset('us_nec');
    });
}

// Apply a standard preset (Indian IS/IEC or US NEC/NEMA) to the profile editor fields
function applyStandardPreset(presetKey) {
    const preset = STANDARD_PRESETS[presetKey];
    if (!preset) return;
    document.getElementById('prof-voltages').value = preset.valid_voltage_levels.join(', ');
    document.getElementById('prof-cable-sizes').value = preset.cable_sizes.join('\n');
    document.getElementById('prof-breaker-ratings').value = preset.breaker_ratings.join('\n');
    setStatus('Loaded ' + preset.name + ' standards preset. Click Save to apply.');
}
function loadProfileList() {
    const list = document.getElementById('profiles-picker-list');
    list.innerHTML = "";
    
    const storedActive = localStorage.getItem('SLD_ACTIVE_PROFILE');
    const storedAll = localStorage.getItem('SLD_PROFILES');
    
    if (storedAll) {
        allProfiles = JSON.parse(storedAll);
    } else {
        allProfiles = [ { ...DEFAULT_PROFILE } ];
        localStorage.setItem('SLD_PROFILES', JSON.stringify(allProfiles));
    }
    
    if (storedActive) {
        activeProfile = JSON.parse(storedActive);
    } else {
        activeProfile = { ...allProfiles[0] };
        localStorage.setItem('SLD_ACTIVE_PROFILE', JSON.stringify(activeProfile));
    }
    
    if (!activeProfile.cable_sizes) activeProfile.cable_sizes = [ ...DEFAULT_PROFILE.cable_sizes ];
    if (!activeProfile.breaker_ratings) activeProfile.breaker_ratings = [ ...DEFAULT_PROFILE.breaker_ratings ];
    
    allProfiles.forEach((prof, index) => {
        const div = document.createElement('div');
        const isActive = (prof.project_name === activeProfile.project_name && prof.client_name === activeProfile.client_name);
        div.className = `profile-picker-item ${isActive ? 'active' : ''}`;
        div.innerHTML = `
            <h4>${prof.project_name}</h4>
            <span>Client: ${prof.client_name} (${prof.project_number})</span>
        `;
        div.addEventListener('click', () => {
            activeProfile = { ...prof };
            localStorage.setItem('SLD_ACTIVE_PROFILE', JSON.stringify(activeProfile));
            loadProfileList();
            
            if (currentPDF && currentPDF.doc) {
                runSingleQAQCEngine();
            }
        });
        list.appendChild(div);
    });
    
    document.getElementById('prof-client').value = activeProfile.client_name;
    document.getElementById('prof-project').value = activeProfile.project_name;
    document.getElementById('prof-number').value = activeProfile.project_number;
    document.getElementById('prof-voltages').value = activeProfile.valid_voltage_levels.join(', ');
    document.getElementById('prof-dwg-rules').value = activeProfile.drawing_number_formats.join('\n');
    document.getElementById('prof-tag-rules').value = activeProfile.equipment_tag_patterns.join('\n');
    document.getElementById('prof-cable-sizes').value = activeProfile.cable_sizes.join('\n');
    document.getElementById('prof-breaker-ratings').value = activeProfile.breaker_ratings.join('\n');
}

function getOrDetectProfile(firstPageText) {
    let client = "Default Client";
    let project = "Default Project";
    let projectNum = "00000";

    const clientMatch = firstPageText.match(/(?:CLIENT|CLIENT[ \t]*NAME|CUSTOMER)[ \t]*(?::-|:|-[ \t]+)[ \t]*([A-Z0-9 \t,&.\-_]+)/i);
    if (clientMatch && clientMatch[1].trim() && clientMatch[1].trim() !== '-') {
        client = clientMatch[1].trim();
    } else {
        const lines = firstPageText.split('\n');
        for (let line of lines) {
            const m = line.match(/(?:CLIENT|CLIENT[ \t]*NAME|CUSTOMER)[ \t]*(?::-|:|-[ \t]+)[ \t]*(.+)/i);
            if (m && m[1].trim() && m[1].trim() !== '-' && !m[1].includes(':-') && !m[1].includes(':')) {
                client = m[1].trim();
                break;
            }
        }
    }

    const projectMatch = firstPageText.match(/(?:PROJECT|PROJECT[ \t]*TITLE|PROJECT[ \t]*NAME)[ \t]*(?::-|:|-[ \t]+)[ \t]*([A-Z0-9 \t,&.\-_]+)/i);
    if (projectMatch && projectMatch[1].trim() && projectMatch[1].trim() !== '-') {
        project = projectMatch[1].trim();
    } else {
        const lines = firstPageText.split('\n');
        for (let line of lines) {
            const m = line.match(/(?:PROJECT|PROJECT[ \t]*TITLE|PROJECT[ \t]*NAME)[ \t]*(?::-|:|-[ \t]+)[ \t]*(.+)/i);
            if (m && m[1].trim() && m[1].trim() !== '-' && !m[1].includes(':-') && !m[1].includes(':')) {
                project = m[1].trim();
                break;
            }
        }
    }

    if (project === "Default Project") {
        if (firstPageText.toUpperCase().includes("MAIN DISTRIBUTION SCHEME")) {
            project = "MAIN DISTRIBUTION SCHEME";
        }
    }
    
    const projNumMatch = firstPageText.match(/(?:PROJECT\s*(?:NO|NUMBER|#)|JOB\s*(?:NO|NUMBER|#)?)\s*[:\-]+\s*([A-Z0-9\-_]+)/i);
    if (projNumMatch && projNumMatch[1].trim()) {
        projectNum = projNumMatch[1].trim();
    }
    
    if (client.length > 50) client = client.substring(0, 50);
    if (project.length > 50) project = project.substring(0, 50);
    
    let storedAll = localStorage.getItem('SLD_PROFILES');
    let profiles = storedAll ? JSON.parse(storedAll) : [ { ...DEFAULT_PROFILE } ];
    
    let match = profiles.find(p => p.project_name.toUpperCase() === project.toUpperCase() && p.client_name.toUpperCase() === client.toUpperCase());
    
    if (match) {
        return { ...match };
    } else {
        const newProf = {
            ...DEFAULT_PROFILE,
            client_name: client,
            project_name: project,
            project_number: projectNum
        };
        profiles.push(newProf);
        localStorage.setItem('SLD_PROFILES', JSON.stringify(profiles));
        return newProf;
    }
}

function autoDetectAndCreateProfile(firstPageText) {
    activeProfile = getOrDetectProfile(firstPageText);
    localStorage.setItem('SLD_ACTIVE_PROFILE', JSON.stringify(activeProfile));
    setStatus(`Auto-selected profile: ${activeProfile.project_name}`);
    loadProfileList();
}

// 5. VIEW 8: DXF ENTITY BLOCK PARSER
function initDXFHandlers() {
    const dropzone = document.getElementById('dxf-dropzone-element');
    const fileInput = document.getElementById('dxf-file-input');
    const checkBtn = document.getElementById('btn-run-dxf-checks');

    dropzone.addEventListener('click', (e) => {
        if (e.target === fileInput) return;
        fileInput.value = '';
        fileInput.click();
    });
    fileInput.addEventListener('click', (e) => {
        e.stopPropagation();
    });
    fileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) loadDXFFile(e.target.files[0]);
    });

    checkBtn.addEventListener('click', runDXFQAQCChecks);
}

function loadDXFFile(file) {
    if (!file || !file.name.endsWith('.dxf')) {
        alert('Please select a valid DXF text file.');
        return;
    }
    
    document.getElementById('dxf-filename').innerText = file.name;
    document.getElementById('dxf-dropzone-element').classList.add('hidden');
    document.getElementById('dxf-file-badge').classList.remove('hidden');
    
    setStatus('Parsing DXF text entries...');
    
    const reader = new FileReader();
    reader.onload = function(e) {
        const text = e.target.result;
        const inserts = parseDXF(text);
        
        // Populate stats
        document.getElementById('cad-stat-inserts').innerText = inserts.length;
        const uniqueBlocks = new Set(inserts.map(item => item.name));
        document.getElementById('cad-stat-blocks').innerText = uniqueBlocks.size;
        const uniqueLayers = new Set(inserts.map(item => item.layer));
        document.getElementById('cad-stat-layers').innerText = uniqueLayers.size;
        
        // Populate block attribute table
        const tbody = document.getElementById('cad-blocks-body');
        if (inserts.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" class="empty-state">No insert entities found in DXF.</td></tr>';
            return;
        }
        
        let html = "";
        inserts.forEach(ins => {
            html += `
                <tr>
                    <td><strong>${ins.name}</strong></td>
                    <td>${ins.layer}</td>
                    <td>${ins.tag}</td>
                    <td>${ins.val}</td>
                    <td>(${ins.x}, ${ins.y})</td>
                </tr>
            `;
        });
        tbody.innerHTML = html;
        
        document.getElementById('btn-run-dxf-checks').removeAttribute('disabled');
        // Store on window context for checking
        window.dxfInserts = inserts;
        setStatus('DXF blocks parsed successfully.');
    };
    reader.readAsText(file);
}

function parseDXF(text) {
    const lines = text.split(/\r?\n/);
    const inserts = [];
    let i = 0;
    
    let currentEntity = null;
    let blockName = "";
    let layer = "";
    let x = 0;
    let y = 0;
    let attribTag = "";
    let attribVal = "";
    
    while (i < lines.length) {
        const code = parseInt(lines[i].trim(), 10);
        const value = lines[i+1] ? lines[i+1].trim() : "";
        i += 2;
        
        if (code === 0) {
            // Commit previous INSERT
            if (currentEntity === 'INSERT' && blockName) {
                inserts.push({
                    name: blockName,
                    layer: layer || "0",
                    tag: attribTag || "LABEL",
                    val: attribVal || "SPARE",
                    x: parseFloat(x || 0).toFixed(2),
                    y: parseFloat(y || 0).toFixed(2)
                });
            }
            currentEntity = value;
            blockName = "";
            layer = "";
            x = 0; y = 0;
            attribTag = ""; attribVal = "";
        } else if (currentEntity === 'INSERT') {
            if (code === 2) blockName = value;
            else if (code === 8) layer = value;
            else if (code === 10) x = value;
            else if (code === 20) y = value;
        } else if (currentEntity === 'ATTRIB') {
            if (code === 2) attribTag = value;
            else if (code === 1) attribVal = value;
        }
    }
    return inserts;
}

function runDXFQAQCChecks() {
    const inserts = window.dxfInserts;
    if (!inserts) return;
    
    const tbody = document.getElementById('cad-findings-body');
    const findings = [];
    
    // Check duplicates
    const seen = {};
    inserts.forEach(ins => {
        if (ins.tag === 'TAG') {
            seen[ins.val] = (seen[ins.val] || 0) + 1;
        }
    });
    
    Object.keys(seen).forEach(tag => {
        if (seen[tag] > 1) {
            findings.push({
                severity: "Critical",
                area: "CAD Blocks",
                desc: `Duplicate Equipment Tag '${tag}' detected in modelspace attributes`,
                expected: "Unique Tag ID",
                found: `${seen[tag]} instances`
            });
        }
    });
    
    // Check disconnected terminal
    inserts.forEach(ins => {
        if (ins.name.includes("SPARE") && ins.layer === "E-POWR-CONN") {
            findings.push({
                severity: "Minor",
                area: "CAD Layers",
                desc: `Terminal block '${ins.name}' on E-POWR-CONN layer has blank target reference`,
                expected: "Connection Line continuation",
                found: "SPARE placeholder rating"
            });
        }
    });

    if (findings.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty-state">No CAD violations found! Drawing complies with standards.</td></tr>';
        return;
    }
    
    let html = "";
    findings.forEach(f => {
        html += `
            <tr>
                <td><span class="badge ${f.severity.toLowerCase()}">${f.severity}</span></td>
                <td>${f.area}</td>
                <td>${f.desc}</td>
                <td>${f.expected}</td>
                <td class="text-danger">${f.found}</td>
            </tr>
        `;
    });
    tbody.innerHTML = html;
    
    // Switch to CAD findings tab
    document.querySelectorAll('[data-dwgtab]').forEach(btn => {
        if (btn.getAttribute('data-dwgtab') === 'dwgtab-findings') btn.click();
    });
}

// 6. VIEW 6: SPEC VERIFICATION
function initSpecHandlers() {
    const fileInput = document.getElementById('spec-file-input');
    if (fileInput) {
        fileInput.addEventListener('click', () => {
            fileInput.value = '';
        });
    }
    const runBtn = document.getElementById('btn-run-spec-verification');
    const exportBtn = document.getElementById('btn-export-spec');
    
    const dropzone = document.getElementById('verification-dropzone');
    const pdfInput = document.getElementById('verification-file-input');
    const clearBtn = document.getElementById('verification-file-clear');

    if (dropzone && pdfInput) {
        dropzone.addEventListener('click', (e) => {
            if (e.target === pdfInput) return;
            pdfInput.value = '';
            pdfInput.click();
        });
        pdfInput.addEventListener('click', (e) => {
            e.stopPropagation();
        });
        pdfInput.addEventListener('change', (e) => {
            if (e.target.files.length > 0) loadSinglePDF(e.target.files[0]);
        });
        
        // Drag & Drop
        dropzone.addEventListener('dragover', (e) => { 
            e.preventDefault(); 
            dropzone.style.borderColor = 'var(--accent)'; 
        });
        dropzone.addEventListener('dragleave', () => { 
            dropzone.style.borderColor = 'var(--border-color)'; 
        });
        dropzone.addEventListener('drop', (e) => {
            e.preventDefault();
            dropzone.style.borderColor = 'var(--border-color)';
            if (e.dataTransfer.files.length > 0) loadSinglePDF(e.dataTransfer.files[0]);
        });
    }

    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            resetSingleView();
        });
    }
    
    runBtn.addEventListener('click', () => {
        if (!fileInput.files[0] || !currentPDF.doc) {
            alert('Please select both a Spec file and load a PDF drawing.');
            return;
        }
        
        const reader = new FileReader();
        reader.onload = function(e) {
            const specText = e.target.result;
            runSpecVerification(specText);
        };
        reader.readAsText(fileInput.files[0]);
    });

    exportBtn.addEventListener('click', () => {
        if (!window.specResults || window.specResults.length === 0) return;
        const headers = ['Specification Requirement', 'Status', 'Found Value on PDF', 'Conflict Suggestion'];
        const rows = window.specResults.map(r => [
            `"${r.requirement.replace(/"/g, '""')}"`,
            r.status,
            `"${r.foundValue.replace(/"/g, '""')}"`,
            `"${r.suggestion.replace(/"/g, '""')}"`
        ]);
        const csvContent = "\ufeff" + [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.setAttribute('href', url);
        link.setAttribute('download', `${currentPDF.name || 'sld'}_spec_verification_report.csv`);
        link.style.visibility = 'hidden';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    });
}

function runSpecVerification(specText) {
    const tbody = document.getElementById('spec-results-body');
    const exportBtn = document.getElementById('btn-export-spec');
    const specLines = specText.split(/\r?\n/).map(s => s.trim()).filter(s => s.length > 0);
    
    const results = [];
    
    specLines.forEach(line => {
        let specItem = "";
        let specVal = "";
        
        if (line.includes(',')) {
            const parts = line.split(',');
            specItem = parts[0].trim();
            specVal = parts[1].trim();
        } else {
            const idx = line.indexOf(':');
            if (idx !== -1) {
                specItem = line.substring(0, idx).trim();
                specVal = line.substring(idx + 1).trim();
            }
        }
        
        if (specItem && specVal) {
            let found = false;
            const isNumeric = /^\d+(?:\.\d+)?$/.test(specVal);
            const searchRegex = isNumeric ? new RegExp(`\\b${specVal}\\b`, 'i') : new RegExp(specVal.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'), 'i');
            
            currentPDF.sheets.forEach(s => {
                if (searchRegex.test(s.text)) {
                    found = true;
                }
            });
            
            results.push({
                requirement: `${specItem} matches '${specVal}'`,
                status: found ? "MATCH" : "CONFLICT",
                foundValue: found ? specVal : "Value not found on drawing",
                suggestion: found ? "Consistent" : `Add spec '${specVal}' to drawing block notes`
            });
        }
    });

    if (results.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" class="empty-state">No valid specification key-value pairs parsed.</td></tr>';
        exportBtn.setAttribute('disabled', 'true');
        window.specResults = [];
        return;
    }
    
    let html = "";
    results.forEach(r => {
        let stClass = r.status === 'MATCH' ? 'text-success' : 'text-danger';
        html += `
            <tr>
                <td>${r.requirement}</td>
                <td><strong class="${stClass}">${r.status}</strong></td>
                <td>${r.foundValue}</td>
                <td>${r.suggestion}</td>
            </tr>
        `;
    });
    tbody.innerHTML = html;
    
    exportBtn.removeAttribute('disabled');
    window.specResults = results;
}

// 7. VIEW 7: BATCH QA/QC DASHBOARD
function initBatchHandlers() {
    const dropzone = document.getElementById('batch-dropzone-element');
    const fileInput = document.getElementById('batch-file-input');
    const runBtn = document.getElementById('btn-run-batch');
    const exportBtn = document.getElementById('btn-batch-export-master');
    
    dropzone.addEventListener('click', (e) => {
        if (e.target === fileInput) return;
        fileInput.value = '';
        fileInput.click();
    });
    fileInput.addEventListener('click', (e) => {
        e.stopPropagation();
    });
    fileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) loadBatchFiles(e.target.files);
    });
    
    // Drag & Drop
    dropzone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropzone.style.borderColor = 'var(--accent)';
    });
    dropzone.addEventListener('dragleave', () => {
        dropzone.style.borderColor = 'var(--border-color)';
    });
    dropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropzone.style.borderColor = 'var(--border-color)';
        if (e.dataTransfer.files.length > 0) loadBatchFiles(e.dataTransfer.files);
    });

    runBtn.addEventListener('click', runBatchProcessing);
    exportBtn.addEventListener('click', exportBatchToCSV);
}

function loadBatchFiles(fileList) {
    const tbody = document.getElementById('batch-table-body');
    tbody.innerHTML = "";
    
    window.batchFiles = [];
    
    Array.from(fileList).forEach((file, index) => {
        window.batchFiles.push({ file: file, status: "Queued", score: "--", issues: "0 / 0 / 0" });
        
        const tr = document.createElement('tr');
        tr.id = `batch-row-${index}`;
        tr.innerHTML = `
            <td><strong>${file.name}</strong></td>
            <td id="score-${index}">--</td>
            <td id="issues-${index}">0 / 0 / 0</td>
            <td id="status-${index}"><span class="badge minor">Queued</span></td>
        `;
        tbody.appendChild(tr);
    });
    
    document.getElementById('btn-run-batch').removeAttribute('disabled');
    setStatus(`Queued ${fileList.length} files for batch review.`);
}

// ─── ANNOTATION-BASED QA/QC ENGINE ──────────────────────────────────────────
// Scans all pages for reviewer comments (Text/FreeText annotations) and
// equipment annotation anomalies, adding them as findings.
async function runAnnotationChecks(doc, sheets) {
    const findings = [];
    const REVIEW_VERBS = ['CHANGE', 'REPLACE', 'ADD', 'REMOVE', 'INCORRECT', 'MISSING',
                          'REVISE', 'UPDATE', 'CHECK', 'VERIFY', 'NOTE:', 'COMMENT:',
                          'WRONG', 'CORRECT', 'FIX', 'MODIFY'];
    const REVIEW_SUBTYPES = new Set(['Text', 'FreeText', 'Popup', 'Stamp', 'Note']);

    for (let i = 0; i < (doc.numPages || 0); i++) {
        let annotations = [];
        try {
            const page = await doc.getPage(i + 1);
            annotations = await page.getAnnotations();
        } catch(e) { continue; }

        // Count equipment annotations for context
        const equipAnnots = [];
        const reviewAnnots = [];

        annotations.forEach(annot => {
            const content = (annot.contentsObj ? annot.contentsObj.str : '') || annot.contents || '';
            const subtype = annot.subtype || '';
            const trimmed = content.trim();
            if (!trimmed) return;

            const isReview = REVIEW_SUBTYPES.has(subtype) ||
                REVIEW_VERBS.some(v => trimmed.toUpperCase().includes(v));

            if (isReview) {
                reviewAnnots.push({ annot, content: trimmed });
            } else {
                equipAnnots.push({ annot, content: trimmed });
            }
        });

        // Each reviewer comment becomes a CRITICAL finding
        reviewAnnots.forEach(({ annot, content }) => {
            const rect = annot.rect || [0, 0, 0, 0];
            const isChange = /change|replace|incorrect|wrong|fix|modify/i.test(content);
            findings.push({
                page: i,
                severity: isChange ? 'Critical' : 'Major',
                category: 'Reviewer Comment',
                description: content,
                expected: 'No reviewer comments on finalised drawing',
                found: `"${content.substring(0, 80)}${content.length > 80 ? '…' : ''}"`,
                suggestion: 'Address reviewer comment and remove annotation before issue.',
                status: 'unreviewed',
                annotRect: rect  // for locate-on-canvas
            });
        });

        // Flag pages that have NO text AND very few annotations (likely unreadable)
        const sheetText = (sheets[i] && sheets[i].text) || '';
        if (sheetText.length < 50 && annotations.length < 10) {
            findings.push({
                page: i,
                severity: 'Major',
                category: 'Data Extraction',
                description: 'Very little extractable data on this page — drawing may be image-based or heavily annotated only',
                expected: 'Text-based or annotated PDF with identifiable elements',
                found: `Only ${sheetText.length} text chars and ${annotations.length} annotations extracted`,
                suggestion: 'Ensure PDF is exported as vector/text, not rasterized. Use AI Identify to analyze visually.',
                status: 'unreviewed'
            });
        }
    }

    return findings;
}

async function analyzePDFFile(file) {
    return new Promise((resolve, reject) => {
        const fileReader = new FileReader();
        fileReader.onload = async function() {
            try {
                const typedarray = new Uint8Array(this.result);
                const doc = await pdfjsLib.getDocument({data: typedarray}).promise;
                
                // Extract PDF metadata
                const metadata = await extractPDFMetadata(doc, file);
                
                const sheets = [];
                let totalTextLength = 0;
                for (let i = 1; i <= doc.numPages; i++) {
                    const page = await doc.getPage(i);
                    const text = await extractPageTextRobust(page);
                    totalTextLength += text.length;
                    
                    let label = `Pg ${i}`;
                    const m = text.match(/\b([A-Z]{1,2}-SLD-\d{3})\b/i);
                    if (m) label = m[1];
                    else if (metadata.title && doc.numPages === 1) label = metadata.filename.substring(0, 20);
                    
                    let title = 'Power Layout';
                    if (text.includes('DISTRIBUTION') || metadata.title.toUpperCase().includes('DISTRIBUTION') ||
                        file.name.toUpperCase().includes('DISTRIBUTION')) {
                        title = 'Main Distribution Scheme';
                    }
                    
                    sheets.push({
                        pageNum: i - 1,
                        label: label,
                        title: title,
                        text: text,
                        healthScore: 100,
                        findings: []
                    });
                }
                
                // Auto-detect project profile for this file
                const fileProfile = sheets.length > 0 ? getOrDetectProfile(sheets[0].text) : activeProfile;
                
                // Run text and structural checks using detected profile
                const textFindings = runChecksOnSheets(sheets, fileProfile);
                const structuralFindings = runStructuralChecks(doc, file, sheets, metadata, totalTextLength, fileProfile);

                // Run annotation-based checks (reviewer sticky notes become CRITICAL findings)
                let annotFindings = [];
                try { annotFindings = await runAnnotationChecks(doc, sheets); } catch(e) { console.warn('annotChecks err:', e); }

                const findings = [...textFindings, ...structuralFindings, ...annotFindings];
                
                const healthScore = calculateHealthScoreFromFindings(findings, sheets.length);
                
                resolve({
                    file: file,
                    doc: doc,
                    name: file.name,
                    sheets: sheets,
                    findings: findings,
                    healthScore: healthScore,
                    page: 0,
                    zoom: 1.5,
                    userMarkups: []
                });
            } catch (err) {
                reject(err);
            }
        };
        fileReader.onerror = () => reject(fileReader.error);
        fileReader.readAsArrayBuffer(file);
    });
}

function loadBatchItemToSingleReview(data) {
    currentPDF = {
        doc: data.doc,
        path: "",
        name: data.name,
        page: data.page,
        zoom: data.zoom,
        findings: data.findings,
        sheets: data.sheets
    };
    userMarkups = data.userMarkups || [];
    
    document.getElementById('single-filename').innerText = data.name;
    document.getElementById('single-dropzone').classList.add('hidden');
    document.getElementById('single-file-badge').classList.remove('hidden');
    
    document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
    const singleReviewBtn = document.querySelector('.nav-item[data-view="view-single"]');
    if (singleReviewBtn) singleReviewBtn.classList.add('active');
    
    document.querySelectorAll('.view-panel').forEach(p => p.classList.add('hidden'));
    document.getElementById('view-single').classList.remove('hidden');
    activeView = "view-single";
    
    renderPage();
    runSingleQAQCEngine(true);
    
    setStatus(`Loaded ${data.name} from batch for detail review.`);
}

async function runBatchProcessing() {
    const files = window.batchFiles;
    if (!files) return;
    
    window.batchProcessedData = {};
    setStatus('Running parallel batch processing...');
    
    const promises = files.map(async (item, i) => {
        const name = item.file.name;
        document.getElementById(`status-${i}`).innerHTML = '<span class="badge major">Analyzing</span>';
        
        try {
            const data = await analyzePDFFile(item.file);
            window.batchProcessedData[name] = data;
            
            const crit = data.findings.filter(f => f.severity === 'Critical').length;
            const maj = data.findings.filter(f => f.severity === 'Major').length;
            const minr = data.findings.filter(f => f.severity === 'Minor').length;
            const score = data.healthScore;
            
            document.getElementById(`score-${i}`).innerText = `${score} / 100`;
            document.getElementById(`issues-${i}`).innerText = `${crit} / ${maj} / ${minr}`;
            document.getElementById(`status-${i}`).innerHTML = score >= 90 ? '<span class="badge approved">Pass</span>' : '<span class="badge major">Review</span>';
            
            const tr = document.getElementById(`batch-row-${i}`);
            tr.style.cursor = 'pointer';
            tr.title = "Click to load and review detailed issues in Single Review tab";
            tr.onclick = () => {
                loadBatchItemToSingleReview(data);
            };
        } catch (err) {
            console.error(err);
            document.getElementById(`status-${i}`).innerHTML = '<span class="badge critical">Error</span>';
            setStatus(`Error analyzing ${name}: ${err.message}`);
        }
    });
    
    await Promise.all(promises);
    document.getElementById('btn-batch-export-master').removeAttribute('disabled');
    setStatus('Batch processing complete. Click any row to review details.');
}

// 8. VIEW 4: PATTERN SCANNER
function initPatternScannerHandlers() {
    const runBtn = document.getElementById('btn-run-scanner');
    const dropzone = document.getElementById('scanner-dropzone');
    const fileInput = document.getElementById('scanner-file-input');
    const clearBtn = document.getElementById('scanner-file-clear');
    const exportBtn = document.getElementById('btn-export-scanner');

    if (dropzone && fileInput) {
        dropzone.addEventListener('click', (e) => {
            if (e.target === fileInput) return;
            fileInput.value = '';
            fileInput.click();
        });
        fileInput.addEventListener('click', (e) => {
            e.stopPropagation();
        });
        fileInput.addEventListener('change', (e) => {
            if (e.target.files.length > 0) loadSinglePDF(e.target.files[0]);
        });
        
        // Drag & Drop
        dropzone.addEventListener('dragover', (e) => { 
            e.preventDefault(); 
            dropzone.style.borderColor = 'var(--accent)'; 
        });
        dropzone.addEventListener('dragleave', () => { 
            dropzone.style.borderColor = 'var(--border-color)'; 
        });
        dropzone.addEventListener('drop', (e) => {
            e.preventDefault();
            dropzone.style.borderColor = 'var(--border-color)';
            if (e.dataTransfer.files.length > 0) loadSinglePDF(e.dataTransfer.files[0]);
        });
    }

    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            resetSingleView();
        });
    }
    
    runBtn.addEventListener('click', () => {
        if (!currentPDF.doc) {
            alert('Please load a PDF drawing first.');
            return;
        }
        
        const patternStr = document.getElementById('scan-regex-pattern').value;
        let regex;
        try {
            regex = new RegExp(patternStr, 'g');
        } catch (e) {
            alert('Invalid regex pattern: ' + e.message);
            return;
        }
        
        const tbody = document.getElementById('scanner-table-body');
        tbody.innerHTML = "";
        
        const matches = [];
        
        currentPDF.sheets.forEach(s => {
            regex.lastIndex = 0; // RESET regex matching pointer for each sheet
            let m;
            while ((m = regex.exec(s.text)) !== null) {
                // extract surrounding text context
                const start = Math.max(0, m.index - 30);
                const end = Math.min(s.text.length, m.index + m[0].length + 30);
                const context = '...' + s.text.substring(start, end).trim() + '...';
                
                // Validate if it matches active profile rules
                let isValid = false;
                for (const fmt of activeProfile.drawing_number_formats) {
                    try {
                        if (new RegExp(fmt, 'i').test(m[0])) { isValid = true; break; }
                    } catch(e) {}
                }
                for (const pat of activeProfile.equipment_tag_patterns) {
                    try {
                        if (new RegExp(pat).test(m[0])) { isValid = true; break; }
                    } catch(e) {}
                }
                
                matches.push({
                    page: s.pageNum,
                    match: m[0],
                    context: context,
                    result: isValid ? "Valid Format" : "Non-standard Format"
                });
            }
        });

        if (matches.length === 0) {
            // Check if sparse text is the reason
            const totalSheetText = currentPDF.sheets.reduce((acc, s) => acc + s.text.length, 0);
            const sparseMsg = totalSheetText < 200
                ? `<tr><td colspan="4" class="empty-state" style="padding: 20px; line-height: 1.8;">
                    ⚠️ <strong>No text found in PDF</strong> (${totalSheetText} chars extracted).<br>
                    This is a vector-based CAD PDF — the Pattern Scanner cannot match text that doesn't exist as searchable content.<br>
                    <em>Try the DWG/DXF tab for native CAD analysis, or re-export your drawing with text embedding enabled.</em>
                   </td></tr>`
                : '<tr><td colspan="4" class="empty-state">No pattern matches detected in document text.</td></tr>';
            tbody.innerHTML = sparseMsg;
            exportBtn.setAttribute('disabled', 'true');
            window.scannerMatches = [];
            return;
        }
        
        let html = "";
        matches.forEach(m => {
            let stClass = m.result === 'Valid Format' ? 'text-success' : 'text-warning';
            html += `
                <tr class="scanner-row-clickable" data-page="${m.page}" style="cursor: pointer;">
                    <td>Pg ${m.page + 1}</td>
                    <td><strong class="font-mono">${m.match}</strong></td>
                    <td>${m.context}</td>
                    <td><span class="${stClass}">${m.result}</span></td>
                </tr>
            `;
        });
        tbody.innerHTML = html;
        
        // Add row clicks
        tbody.querySelectorAll('.scanner-row-clickable').forEach(row => {
            row.addEventListener('click', () => {
                const page = parseInt(row.getAttribute('data-page'), 10);
                currentPDF.page = page;
                const singleReviewBtn = document.querySelector('.nav-item[data-view="view-single"]');
                if (singleReviewBtn) singleReviewBtn.click();
                renderPage();
            });
        });
        
        exportBtn.removeAttribute('disabled');
        window.scannerMatches = matches;
        setStatus(`Scanner matched ${matches.length} patterns.`);
    });

    exportBtn.addEventListener('click', () => {
        if (!window.scannerMatches || window.scannerMatches.length === 0) return;
        const headers = ['Page', 'Match String', 'Context Block', 'Result'];
        const rows = window.scannerMatches.map(m => [
            m.page + 1,
            `"${m.match.replace(/"/g, '""')}"`,
            `"${m.context.replace(/"/g, '""')}"`,
            m.result
        ]);
        const csvContent = "\ufeff" + [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.setAttribute('href', url);
        link.setAttribute('download', `${currentPDF.name || 'sld'}_scanner_matches.csv`);
        link.style.visibility = 'hidden';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    });
}

// 9. VIEW 9: INTERACTIVE GRAPH CANVAS (Force Directed physics in web browser)
function initGraphCanvas() {
    const gCanvas = document.getElementById('view-graph-canvas');
    if (!gCanvas) return;
    
    if (!graphInitialized) {
        gCanvas.addEventListener('mousedown', onGraphMouseDown);
        gCanvas.addEventListener('mousemove', onGraphMouseMove);
        gCanvas.addEventListener('mouseup', onGraphMouseUp);
        gCanvas.addEventListener('wheel', onGraphWheel);
        gCanvas.addEventListener('dblclick', onGraphDblClick);
        
        const layoutSelect = document.getElementById('view-graph-layout-select');
        if (layoutSelect) layoutSelect.addEventListener('change', recalculateGraphLayout);
        
        const physicsToggle = document.getElementById('btn-view-physics-toggle');
        if (physicsToggle) physicsToggle.addEventListener('click', togglePhysics);
        
        const resetBtn = document.getElementById('btn-view-graph-reset');
        if (resetBtn) resetBtn.addEventListener('click', resetGraphView);
        
        window.addEventListener('resize', resizeGraphCanvas);
        graphInitialized = true;
    }
    
    resizeGraphCanvas();
}

function onGraphDblClick(e) {
    const rect = e.target.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    
    const node = getNodeAt(sx, sy);
    if (node) {
        if (node.fileName && window.batchProcessedData && window.batchProcessedData[node.fileName]) {
            // Load this file from batch data into Single Review
            const data = window.batchProcessedData[node.fileName];
            data.page = node.pageNum;
            loadBatchItemToSingleReview(data);
            setStatus(`Loaded ${node.fileName} (Page ${node.pageNum + 1}) from batch via graph double-click.`);
        } else {
            // Fallback for single PDF sheets
            currentPDF.page = node.id;
            const singleReviewBtn = document.querySelector('.nav-item[data-view="view-single"]');
            if (singleReviewBtn) {
                singleReviewBtn.click();
            }
            renderPage();
            setStatus(`Switched to page ${node.id + 1} (${node.label}) from graph view.`);
        }
    }
}

function resizeGraphCanvas() {
    const gCanvas = document.getElementById('view-graph-canvas');
    if (!gCanvas || activeView !== 'view-graph') return;
    
    const rect = gCanvas.parentElement.getBoundingClientRect();
    gCanvas.width = rect.width;
    gCanvas.height = rect.height;
    
    // Load nodes from current PDF findings
    buildGraphFromPDF();
    recalculateGraphLayout();
}

function buildGraphFromPDF() {
    graphNodes = [];
    graphEdges = [];
    
    // Check if we have batch processed data to display
    const hasBatchData = window.batchProcessedData && Object.keys(window.batchProcessedData).length > 0;
    
    if (hasBatchData) {
        // Build graph from all sheets in the batch
        let globalIdx = 0;
        const pageToGlobalId = {}; // Maps `${fileName}_${pageNum}` to globalIdx
        
        // 1. Create nodes for all sheets in all batch files
        Object.keys(window.batchProcessedData).forEach(fileName => {
            const data = window.batchProcessedData[fileName];
            data.sheets.forEach(s => {
                const isPrimary = (s.title && s.title.toUpperCase().includes('MAIN')) || 
                                  (s.label && s.label.toUpperCase().includes('MAIN')) ||
                                  (fileName.toUpperCase().includes('MAIN'));
                graphNodes.push({
                    id: globalIdx,
                    label: s.label || s.title || fileName.substring(0, 15),
                    title: s.title || fileName,
                    fileName: fileName,
                    pageNum: s.pageNum,
                    isPrimary: isPrimary,
                    score: s.healthScore || 100,
                    x: 0, y: 0, dx: 0, dy: 0
                });
                pageToGlobalId[`${fileName}_${s.pageNum}`] = globalIdx;
                globalIdx++;
            });
        });
        
        // 2. Identify cross-references within and between all batch files
        Object.keys(window.batchProcessedData).forEach(fileName => {
            const data = window.batchProcessedData[fileName];
            data.sheets.forEach(s => {
                const u = pageToGlobalId[`${fileName}_${s.pageNum}`];
                if (u === undefined) return;
                
                const seenTargets = new Set();
                
                // Scan text of sheet s for any references to other sheet labels
                graphNodes.forEach(node => {
                    if (node.id === u) return; // Don't link to self
                    
                    // Match by exact drawing number label (case-insensitive, e.g. "IP-SLD-001")
                    if (node.label && node.label !== 'Pg ' + (node.pageNum + 1)) {
                        const escapedLabel = node.label.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
                        const labelRegex = new RegExp('\\b' + escapedLabel + '\\b', 'i');
                        if (labelRegex.test(s.text) && !seenTargets.has(node.id)) {
                            seenTargets.add(node.id);
                            graphEdges.push({ u: u, v: node.id });
                        }
                    }
                    
                    // Match by file name references
                    const cleanFileName = node.fileName.replace('.pdf', '');
                    const escapedFile = cleanFileName.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
                    const fileRegex = new RegExp('\\b' + escapedFile + '\\b', 'i');
                    if (fileRegex.test(s.text) && !seenTargets.has(node.id)) {
                        seenTargets.add(node.id);
                        graphEdges.push({ u: u, v: node.id });
                    }
                });
                
                // Fallback: Check traditional "SEE SHEET X" inside the same file
                const refRegex = /SEE\s*(?:SHEET)?\s*(\d+)\b/ig;
                let m;
                while ((m = refRegex.exec(s.text)) !== null) {
                    const targetPageNum = parseInt(m[1], 10) - 1;
                    const v = pageToGlobalId[`${fileName}_${targetPageNum}`];
                    if (v !== undefined && v !== u && !seenTargets.has(v)) {
                        seenTargets.add(v);
                        graphEdges.push({ u: u, v: v });
                    }
                }
            });
        });
    } else {
        // Fallback: Build graph from the single active PDF sheets
        if (!currentPDF || !currentPDF.sheets || currentPDF.sheets.length === 0) return;
        
        currentPDF.sheets.forEach((s, idx) => {
            const isPrimary = (s.title && s.title.toUpperCase().includes('MAIN')) || 
                              (s.label && s.label.toUpperCase().includes('MAIN'));
            graphNodes.push({
                id: idx,
                label: s.label,
                title: s.title,
                isPrimary: isPrimary,
                score: s.healthScore || 100,
                x: 0, y: 0, dx: 0, dy: 0
            });
        });
        
        // Match drawing labels in standard text across sheets of the same PDF
        currentPDF.sheets.forEach((s, idx) => {
            const seenTargets = new Set();
            
            graphNodes.forEach(node => {
                if (node.id === idx) return;
                
                if (node.label && node.label !== 'Pg ' + (node.id + 1)) {
                    const escapedLabel = node.label.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
                    const labelRegex = new RegExp('\\b' + escapedLabel + '\\b', 'i');
                    if (labelRegex.test(s.text) && !seenTargets.has(node.id)) {
                        seenTargets.add(node.id);
                        graphEdges.push({ u: idx, v: node.id });
                    }
                }
            });
            
            const refRegex = /SEE\s*(?:SHEET)?\s*(\d+)\b/ig;
            let m;
            while ((m = refRegex.exec(s.text)) !== null) {
                const target = parseInt(m[1], 10) - 1;
                if (target >= 0 && target < currentPDF.sheets.length && target !== idx && !seenTargets.has(target)) {
                    seenTargets.add(target);
                    graphEdges.push({ u: idx, v: target });
                }
            }
        });
    }
}

function recalculateGraphLayout() {
    const layout = document.getElementById('view-graph-layout-select').value;
    const gCanvas = document.getElementById('view-graph-canvas');
    const W = gCanvas.width;
    const H = gCanvas.height;
    
    if (graphNodes.length === 0) return;
    
    if (layout === 'circular') {
        const cx = W / 2;
        const cy = H / 2;
        const R = Math.min(W, H) * 0.35;
        graphNodes.forEach((n, idx) => {
            const theta = (2 * Math.PI * idx) / graphNodes.length;
            n.x = cx + R * Math.cos(theta);
            n.y = cy + R * Math.sin(theta);
        });
    } else if (layout === 'grid') {
        const cols = Math.ceil(Math.sqrt(graphNodes.length));
        const dx = W / (cols + 1);
        const dy = H / (Math.ceil(graphNodes.length / cols) + 1);
        graphNodes.forEach((n, idx) => {
            const r = Math.floor(idx / cols);
            const c = idx % cols;
            n.x = dx * (c + 1);
            n.y = dy * (r + 1);
        });
    } else if (layout === 'tree') {
        const dx = W / (graphNodes.length + 1);
        const cy = H / 2;
        graphNodes.forEach((n, idx) => {
            n.x = dx * (idx + 1);
            n.y = cy + (idx % 2 === 0 ? 50 : -50);
        });
    } else { // force
        const cx = W / 2;
        const cy = H / 2;
        const R = 80;
        graphNodes.forEach((n, idx) => {
            const theta = (2 * Math.PI * idx) / graphNodes.length;
            n.x = cx + R * Math.cos(theta) + (Math.random() - 0.5) * 10;
            n.y = cy + R * Math.sin(theta) + (Math.random() - 0.5) * 10;
            n.dx = 0; n.dy = 0;
        });
        // pre-run physics loop
        for (let k = 0; k < 100; k++) {
            applyPhysicsStepJS();
        }
    }
    
    drawGraph();
}

function applyPhysicsStepJS() {
    const gCanvas = document.getElementById('view-graph-canvas');
    if (!gCanvas) return;
    
    const W = gCanvas.width;
    const H = gCanvas.height;
    const kr = 30000.0;
    const ka = 0.05;
    const rest = 140;
    
    // Repel
    for (let i = 0; i < graphNodes.length; i++) {
        const n1 = graphNodes[i];
        for (let j = 0; j < graphNodes.length; j++) {
            if (i === j) continue;
            const n2 = graphNodes[j];
            const dx = n1.x - n2.x;
            const dy = n1.y - n2.y;
            const dist = Math.sqrt(dx*dx + dy*dy) || 1.0;
            if (dist < 260) {
                const force = kr / (dist * dist);
                n1.dx += (dx / dist) * force;
                n1.dy += (dy / dist) * force;
            }
        }
    }
    
    // Attract
    graphEdges.forEach(e => {
        const n1 = graphNodes[e.u];
        const n2 = graphNodes[e.v];
        const dx = n2.x - n1.x;
        const dy = n2.y - n1.y;
        const dist = Math.sqrt(dx*dx + dy*dy) || 1.0;
        const force = ka * (dist - rest);
        
        n1.dx += (dx / dist) * force;
        n1.dy += (dy / dist) * force;
        n2.dx -= (dx / dist) * force;
        n2.dy -= (dy / dist) * force;
    });
    
    // Gravity
    const cx = W / 2;
    const cy = H / 2;
    graphNodes.forEach(n => {
        const dx = cx - n.x;
        const dy = cy - n.y;
        const dist = Math.sqrt(dx*dx + dy*dy) || 1.0;
        n.dx += (dx / dist) * 0.04;
        n.dy += (dy / dist) * 0.04;
    });
    
    // Move
    graphNodes.forEach(n => {
        if (n === graphDraggedNode) return;
        n.dx *= 0.65;
        n.dy *= 0.65;
        n.x += n.dx;
        n.y += n.dy;
        
        n.x = Math.max(30, Math.min(W - 30, n.x));
        n.y = Math.max(30, Math.min(H - 30, n.y));
    });
}

function runPhysicsLoop() {
    if (!isPhysicsSimulating || document.getElementById('view-graph-layout-select').value !== 'force') return;
    
    applyPhysicsStepJS();
    drawGraph();
    graphSimTimer = requestAnimationFrame(runPhysicsLoop);
}

function drawGraph() {
    const gCanvas = document.getElementById('view-graph-canvas');
    if (!gCanvas) return;
    
    const ctx = gCanvas.getContext('2d');
    const W = gCanvas.width;
    const H = gCanvas.height;
    ctx.clearRect(0, 0, W, H);
    
    if (graphNodes.length === 0) {
        ctx.fillStyle = '#5e6b7d';
        ctx.font = '14px Outfit, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('No drawing set loaded. Load a PDF and run checks in Single Review first.', W / 2, H / 2);
        return;
    }
    
    ctx.save();
    // zoom/pan
    ctx.translate(W/2 + graphPan.x, H/2 + graphPan.y);
    ctx.scale(graphZoom, graphZoom);
    ctx.translate(-W/2, -H/2);
    
    // Draw Edges
    graphEdges.forEach(e => {
        const n1 = graphNodes[e.u];
        const n2 = graphNodes[e.v];
        const active = (graphSelectedNode === n1 || graphSelectedNode === n2 || graphHoveredNode === n1 || graphHoveredNode === n2);
        
        ctx.beginPath();
        ctx.moveTo(n1.x, n1.y);
        
        const dx = n2.x - n1.x;
        const dy = n2.y - n1.y;
        const dist = Math.sqrt(dx*dx + dy*dy) || 1.0;
        const nx = -dy / dist;
        const ny = dx / dist;
        const mx = (n1.x + n2.x) / 2 + nx * 20;
        const my = (n1.y + n2.y) / 2 + ny * 20;
        
        ctx.quadraticCurveTo(mx, my, n2.x, n2.y);
        ctx.strokeStyle = active ? '#2962ff' : '#272c3a';
        ctx.lineWidth = active ? 2 : 1;
        ctx.stroke();
        
        // draw arrow
        drawArrowhead(mx, my, n2.x, n2.y, active ? '#2962ff' : '#272c3a');
    });
    
    // Draw Nodes
    graphNodes.forEach(n => {
        const r = n.isPrimary ? 30 : 24;
        let color = '#10b981';
        let border = '#059669';
        if (n.score < 70) { color = '#ef4444'; border = '#dc2626'; }
        else if (n.score < 90) { color = '#f59e0b'; border = '#d97706'; }
        
        const isHovered = (graphHoveredNode === n);
        const isSelected = (graphSelectedNode === n);
        
        // shadow
        ctx.beginPath();
        ctx.arc(n.x + 2, n.y + 2, r, 0, 2 * Math.PI);
        ctx.fillStyle = 'rgba(0,0,0,0.5)';
        ctx.fill();
        
        // body
        ctx.beginPath();
        ctx.arc(n.x, n.y, r, 0, 2 * Math.PI);
        ctx.fillStyle = color;
        ctx.fill();
        
        ctx.strokeStyle = isSelected ? '#ffffff' : (isHovered ? '#e0e0e0' : border);
        ctx.lineWidth = isSelected ? 3 : (isHovered ? 2 : 1.5);
        ctx.stroke();
        
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 11px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(n.label, n.x, n.y);
    });
    
    ctx.restore();
}

function resetGraphView() {
    graphZoom = 1.0;
    graphPan = { x: 0, y: 0 };
    drawGraph();
}

function togglePhysics() {
    isPhysicsSimulating = !isPhysicsSimulating;
    document.getElementById('btn-view-physics-toggle').innerText = isPhysicsSimulating ? '⏸ Pause Physics' : '▶ Run Physics';
    if (isPhysicsSimulating) runPhysicsLoop();
}

function getNodeAt(sx, sy) {
    const gCanvas = document.getElementById('view-graph-canvas');
    const W = gCanvas.width;
    const H = gCanvas.height;
    
    // unproject
    const lx = (sx - graphPan.x - W/2) / graphZoom + W/2;
    const ly = (sy - graphPan.y - H/2) / graphZoom + H/2;
    
    for (let i = 0; i < graphNodes.length; i++) {
        const n = graphNodes[i];
        const d = Math.sqrt((n.x - lx)**2 + (n.y - ly)**2);
        if (d <= 28) return n;
    }
    return null;
}

function onGraphMouseDown(e) {
    const rect = e.target.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    
    graphLastMouse = { x: sx, y: sy };
    
    const node = getNodeAt(sx, sy);
    if (node) {
        graphDraggedNode = node;
        graphSelectedNode = node;
    } else {
        graphSelectedNode = null;
    }
    drawGraph();
}

function onGraphMouseMove(e) {
    const rect = e.target.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    
    const node = getNodeAt(sx, sy);
    if (node !== graphHoveredNode) {
        graphHoveredNode = node;
        drawGraph();
    }
    
    if (graphDraggedNode) {
        const gCanvas = document.getElementById('view-graph-canvas');
        const W = gCanvas.width;
        const H = gCanvas.height;
        const lx = (sx - graphPan.x - W/2) / graphZoom + W/2;
        const ly = (sy - graphPan.y - H/2) / graphZoom + H/2;
        
        graphDraggedNode.x = Math.max(30, Math.min(W - 30, lx));
        graphDraggedNode.y = Math.max(30, Math.min(H - 30, ly));
        drawGraph();
    } else if (e.buttons === 1) {
        const dx = sx - graphLastMouse.x;
        const dy = sy - graphLastMouse.y;
        graphPan.x += dx;
        graphPan.y += dy;
        drawGraph();
    }
    
    graphLastMouse = { x: sx, y: sy };
}

function onGraphMouseUp() {
    graphDraggedNode = null;
}

function onGraphWheel(e) {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.08 : 0.92;
    const newZoom = graphZoom * factor;
    if (newZoom >= 0.2 && newZoom <= 4.0) {
        graphZoom = newZoom;
        drawGraph();
    }
}

function normalizeCableSizeJS(size_str) {
    let s = size_str.toLowerCase().trim();
    s = s.replace(/\s+/g, ''); // remove all spaces
    if (s.startsWith('#')) s = s.substring(1);
    s = s.replace('mm²', 'sqmm');
    s = s.replace('mm2', 'sqmm');
    s = s.replace('sqmm', 'sqmm');
    s = s.replace('sq', 'sq');
    s = s.replace('mcm', 'kcmil');
    if (s.includes('sqmm')) {
        // ok
    } else if (s.includes('kcmil')) {
        // ok
    } else if (!s.includes('awg')) {
        if (/^(?:[1-4]\/0|\d+)$/.test(s)) {
            s = s + 'awg';
        }
    }
    return s;
}

// Global utilities
function setStatus(msg) {
    document.getElementById('global-status-text').innerText = msg;
    document.getElementById('statusbar-message').innerText = msg;
}

function drawArrowhead(x1, y1, x2, y2, color) {
    const gCanvas = document.getElementById('view-graph-canvas');
    if (!gCanvas) return;
    const ctx = gCanvas.getContext('2d');
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const r = 24; // Node radius is 24
    const tx = x2 - r * Math.cos(angle);
    const ty = y2 - r * Math.sin(angle);
    
    ctx.save();
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.moveTo(tx, ty);
    ctx.lineTo(tx - 10 * Math.cos(angle - Math.PI/6), ty - 10 * Math.sin(angle - Math.PI/6));
    ctx.lineTo(tx - 10 * Math.cos(angle + Math.PI/6), ty - 10 * Math.sin(angle + Math.PI/6));
    ctx.closePath();
    ctx.fill();
    ctx.restore();
}

function exportReportToCSV() {
    if (!currentPDF.findings || currentPDF.findings.length === 0) {
        alert('No findings to export.');
        return;
    }
    const headers = ['Page', 'Severity', 'Check Area', 'Error Description', 'Expected Value', 'Found Value', 'Recommendation', 'Status'];
    const rows = currentPDF.findings.map(f => [
        f.page + 1,
        f.severity,
        f.category,
        `"${(f.description || '').replace(/"/g, '""')}"`,
        `"${(f.expected || '').replace(/"/g, '""')}"`,
        `"${(f.found || '').replace(/"/g, '""')}"`,
        `"${(f.suggestion || '').replace(/"/g, '""')}"`,
        f.status || 'unreviewed'
    ]);
    const csvContent = "\ufeff" + [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `${currentPDF.name || 'sld'}_qaqc_report.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setStatus('Report exported successfully as CSV.');
}

function exportBatchToCSV() {
    if (!window.batchProcessedData || Object.keys(window.batchProcessedData).length === 0) {
        alert('No batch data to export.');
        return;
    }
    const headers = ['File Name', 'Page', 'Severity', 'Check Area', 'Error Description', 'Expected Value', 'Found Value', 'Recommendation'];
    const rows = [];
    
    Object.keys(window.batchProcessedData).forEach(fileName => {
        const data = window.batchProcessedData[fileName];
        data.findings.forEach(f => {
            if (f.severity === 'Valid') return;
            rows.push([
                `"${fileName.replace(/"/g, '""')}"`,
                f.page + 1,
                f.severity,
                f.category,
                `"${(f.description || '').replace(/"/g, '""')}"`,
                `"${(f.expected || '').replace(/"/g, '""')}"`,
                `"${(f.found || '').replace(/"/g, '""')}"`,
                `"${(f.suggestion || '').replace(/"/g, '""')}"`
            ]);
        });
    });
    
    if (rows.length === 0) {
        alert('No findings found in batch files to export.');
        return;
    }
    
    const csvContent = "\ufeff" + [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', 'batch_qaqc_master_report.csv');
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setStatus('Batch master report exported successfully.');
}
