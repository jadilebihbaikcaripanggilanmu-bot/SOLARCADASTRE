// Tangkap error global
window.onerror = function(msg, src, line, col, err) {
    console.error('[Global Error]', msg, 'at', src, line + ':' + col);
    if (window._guaranteedCloseOverlay) window._guaranteedCloseOverlay();
    return false;
};
window.onunhandledrejection = function(e) {
    console.error('[Unhandled Promise]', e.reason);
};

try {
// ============================================================
//  SUPABASE CONFIG
// ============================================================
const SUPABASE_URL      = 'https://odzgdawrtgbwdpesxrwd.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_CefxNyDWHK3F4YzlPdwwIQ_vv4hw0Ek';

// Solar & financial constants
const PERF_RATIO        = 0.75;
const TARIFF_IDR        = 1444.70; // Rp/kWh average tariff
const COST_PER_WP       = 8000;    // Rp/Wp average solar cost
const CO2_KG_PER_KWH    = 0.87;    // kg CO2/kWh reduction

let supabase = null;
let userSession = null;
let localProjects = [];

// Initialize Supabase Client
try {
    if (window.supabase && window.supabase.createClient) {
        supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
        console.log('[Supabase] Client initialized successfully.');
    }
} catch (e) {
    console.warn('[Supabase] Gagal menginisialisasi sdk client:', e.message);
}

// ============================================================
//  MAP INIT
// ============================================================
const map = new maplibregl.Map({
    container: 'map',
    style: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
    center: [113.9213, -0.7893], // Center over Indonesia
    zoom: 5,
    pitch: 0,
    bearing: 0,
    antialias: true
});

map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-left');
map.addControl(new maplibregl.ScaleControl({ maxWidth: 120, unit: 'metric' }), 'bottom-left');

// ============================================================
//  STATE VARIABLES
// ============================================================
let drawMode = 'rectangle'; // 'rectangle', 'circle', 'polygon'
let drawState = 'idle'; // idle, start, drawing, completed
let cornerA = null; // for rectangle
let cornerB = null; // for rectangle
let circleCenter = null; // for circle (lng, lat)
let circleRadius = 0; // for circle (meters)
let polygonPts = []; // for polygon (array of [lng, lat])
let aoiAreaM2 = 0;

let allGeojsonData = null; // raw OSM features from Overpass
let geojsonData = null;    // filtered features currently rendered

let currentFeature = null;
let currentArea = 0;
let isSatelliteOn = false;
let authMode = 'login'; // login, register

const analysisState = {
    controller: null,
    active: false,
    cancelled: false,
    stages: ['validate','connect','download','process','solar','visualize','finalize'],
    currentStage: null
};

// ============================================================
//  UI FORMATTING HELPERS
// ============================================================
function fmt(n, decimals = 0) {
    if (n == null || isNaN(n)) return '—';
    return Number(n).toLocaleString('id-ID', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}
function fmtIDR(n) {
    if (n == null || isNaN(n)) return '—';
    if (n >= 1e9) return 'Rp ' + fmt(n/1e9, 1) + ' M';
    if (n >= 1e6) return 'Rp ' + fmt(n/1e6, 1) + ' Jt';
    return 'Rp ' + fmt(n);
}
function setStatus(msg, type = '') {
    const bar = document.getElementById('status-bar');
    if (!bar) return;
    bar.className = type;
    bar.innerHTML = `<i class="fa fa-${type === 'success' ? 'circle-check' : type === 'error' ? 'circle-exclamation' : 'circle-notch fa-spin'}"></i><span>${msg}</span>`;
}
function showToast(msg, type = 'info') {
    const t = document.getElementById('toast');
    if (!t) return;
    t.textContent = msg;
    t.className = `show toast-${type}`;
    setTimeout(() => t.className = '', 3200);
}

function updateAnalysisQueue(taskId, message, status) {
    const label = document.getElementById(`task-${taskId}`);
    const statusLabel = document.getElementById(`task-${taskId}-status`);
    if (label) label.textContent = message;
    if (statusLabel) {
        statusLabel.textContent = status === 'done' ? 'Selesai' : status === 'active' ? 'Berlangsung' : status === 'pending' ? 'Pending' : status === 'error' ? 'Error' : status;
        statusLabel.className = `task-status status-${status}`;
    }
}

function setAnalysisStage(stage, message, status) {
    analysisState.currentStage = stage;
    const title = document.getElementById(`stage-${stage}-sub`);
    const badge = document.getElementById(`stage-${stage}-status`);
    if (title) title.textContent = message;
    if (badge) {
        badge.textContent = status === 'done' ? 'Selesai' : status === 'active' ? 'Berlangsung' : status === 'pending' ? 'Pending' : status === 'error' ? 'Error' : status;
        badge.className = `stage-status status-${status}`;
    }
    const progressIndex = analysisState.stages.indexOf(stage);
    if (progressIndex >= 0) {
        const percent = Math.round(((progressIndex + (status === 'done' ? 1 : 0)) / analysisState.stages.length) * 100);
        const progressInner = document.getElementById('analysis-progress-inner');
        if (progressInner) progressInner.style.width = `${percent}%`;
    }
}

function resetAnalysisQueue() {
    analysisState.stages.forEach(stage => {
        setAnalysisStage(stage, 'Menunggu', 'pending');
    });
    const progressInner = document.getElementById('analysis-progress-inner');
    if (progressInner) progressInner.style.width = '0%';
    
    const metaAoi = document.getElementById('analysis-meta-aoi');
    if (metaAoi) metaAoi.textContent = '—';
    const metaBuildings = document.getElementById('analysis-meta-buildings');
    if (metaBuildings) metaBuildings.textContent = '—';
    const metaSize = document.getElementById('analysis-meta-size');
    if (metaSize) metaSize.textContent = '—';
    const metaTime = document.getElementById('analysis-meta-time');
    if (metaTime) metaTime.textContent = '—';
}

function showAnalysisOverlay() {
    const overlay = document.getElementById('analysis-overlay');
    if (overlay) overlay.classList.add('active');
    const queueCard = document.getElementById('analysis-queue-card');
    if (queueCard) queueCard.style.display = 'grid';
}

function hideAnalysisOverlay() {
    const overlay = document.getElementById('analysis-overlay');
    if (overlay) overlay.classList.remove('active');
}

function updateAnalysisSummary(areaKm2) {
    const summaryAoi = document.getElementById('summary-aoi-area');
    if (summaryAoi) summaryAoi.textContent = areaKm2 > 0 ? `${fmt(areaKm2, 3)} km²` : '—';
    const metaAoi = document.getElementById('analysis-meta-aoi');
    if (metaAoi) metaAoi.textContent = areaKm2 > 0 ? `${fmt(areaKm2, 3)} km²` : '—';
    
    const summaryDataSize = document.getElementById('summary-data-size');
    const aoiEstSize = document.getElementById('aoi-est-size');
    if (summaryDataSize && aoiEstSize) summaryDataSize.textContent = aoiEstSize.textContent;
    
    const summaryEstTime = document.getElementById('summary-est-time');
    const aoiEstTime = document.getElementById('aoi-est-time');
    if (summaryEstTime && aoiEstTime) summaryEstTime.textContent = aoiEstTime.textContent;
}

function updateAnalysisCounts(count) {
    const summaryBuildingCount = document.getElementById('summary-building-count');
    if (summaryBuildingCount) summaryBuildingCount.textContent = count ? fmt(count) : '—';
    const metaBuildings = document.getElementById('analysis-meta-buildings');
    if (metaBuildings) metaBuildings.textContent = count ? fmt(count) : '—';
}

function updateAnalysisDataEstimate() {
    const metaSize = document.getElementById('analysis-meta-size');
    const aoiEstSize = document.getElementById('aoi-est-size');
    if (metaSize && aoiEstSize) metaSize.textContent = aoiEstSize.textContent;
    
    const metaTime = document.getElementById('analysis-meta-time');
    const aoiEstTime = document.getElementById('aoi-est-time');
    if (metaTime && aoiEstTime) metaTime.textContent = aoiEstTime.textContent;
}

function cancelAnalysis() {
    if (!analysisState.active || !analysisState.controller) return;
    analysisState.cancelled = true;
    analysisState.controller.abort();
    setStatus('Membatalkan analisis...', 'info');
    showToast('Analisis dibatalkan oleh pengguna.', 'info');
}

async function fetchWithRetry(url, options = {}, timeout = 30000, retries = 1) {
    for (let attempt = 0; attempt <= retries; attempt++) {
        if (analysisState.cancelled) throw new Error('cancelled');
        const controller = new AbortController();
        const signal = controller.signal;
        let abortListener = null;
        if (options.signal) {
            if (options.signal.aborted) controller.abort();
            else {
                abortListener = () => controller.abort();
                options.signal.addEventListener('abort', abortListener, { once: true });
            }
        }
        const timeoutId = setTimeout(() => controller.abort(), timeout);
        try {
            const response = await fetch(url, { ...options, signal });
            clearTimeout(timeoutId);
            if (abortListener && options.signal) options.signal.removeEventListener('abort', abortListener);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return await response.json();
        } catch (err) {
            clearTimeout(timeoutId);
            if (abortListener && options.signal) options.signal.removeEventListener('abort', abortListener);
            if (analysisState.cancelled || err.name === 'AbortError') {
                throw new Error('cancelled');
            }
            if (attempt === retries) throw err;
            await waitFor(650 + attempt * 350);
        }
    }
}

async function waitFor(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Toggle sidebar accordions
window.toggleAccordion = function(contentId, chevronId) {
    const content = document.getElementById(contentId);
    const chevron = document.getElementById(chevronId);
    if (!content) return;
    content.classList.toggle('open');
    if (chevron) {
        chevron.className = content.classList.contains('open') ? 'fa fa-chevron-down' : 'fa fa-chevron-right';
    }
};

// ============================================================
//  CUSTOM DRAWING TOOL LOGIC
// ============================================================
// ============================================================
//  CUSTOM DRAWING TOOL LOGIC & UTILITIES
// ============================================================
window.setDrawMode = function(mode) {
    if (drawState !== 'idle') {
        showToast('⚠️ Batalkan/selesaikan penggambaran yang sedang berjalan terlebih dahulu!', 'warning');
        return;
    }
    drawMode = mode;
    
    // Update active button states
    ['rect', 'circle', 'poly'].forEach(m => {
        const btn = document.getElementById(`mode-${m}-btn`);
        if (btn) {
            if (m === (mode === 'rectangle' ? 'rect' : mode === 'circle' ? 'circle' : 'poly')) {
                btn.classList.add('active');
            } else {
                btn.classList.remove('active');
            }
        }
    });

    const statusMap = {
        'rectangle': 'Gunakan tombol "Mulai Menggambar" lalu klik sudut awal dan sudut akhir di peta.',
        'circle': 'Gunakan tombol "Mulai Menggambar" lalu klik titik pusat dan geser untuk radius.',
        'polygon': 'Gunakan tombol "Mulai Menggambar" lalu klik beberapa titik di peta.'
    };
    setStatus(statusMap[mode], 'info');
};

function getDistanceMeters(pt1, pt2) {
    const R = 6371000; // Earth radius in meters
    const lat1 = pt1[1] * Math.PI / 180;
    const lat2 = pt2[1] * Math.PI / 180;
    const dLat = (pt2[1] - pt1[1]) * Math.PI / 180;
    const dLon = (pt2[0] - pt1[0]) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(lat1) * Math.cos(lat2) *
              Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
}

function createCirclePolygon(center, radiusMeters, points = 64) {
    const coords = [];
    const distanceX = radiusMeters / (111320 * Math.cos(center[1] * Math.PI / 180));
    const distanceY = radiusMeters / 110540;

    for (let i = 0; i < points; i++) {
        const theta = (i / points) * (2 * Math.PI);
        const x = distanceX * Math.cos(theta);
        const y = distanceY * Math.sin(theta);
        coords.push([center[0] + x, center[1] + y]);
    }
    coords.push(coords[0]); // Close polygon
    return {
        type: 'Polygon',
        coordinates: [coords]
    };
}

function isPointInPolygon(pt, polygon) {
    const x = pt[0], y = pt[1];
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const xi = polygon[i][0], yi = polygon[i][1];
        const xj = polygon[j][0], yj = polygon[j][1];
        const intersect = ((yi > y) !== (yj > y))
            && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
        if (intersect) inside = !inside;
    }
    return inside;
}

window.toggleAoiDrawing = function() {
    const btn = document.getElementById('draw-aoi-btn');
    if (!btn) return;
    
    if (drawState === 'idle') {
        drawState = 'start';
        btn.classList.add('active');
        btn.innerHTML = '<i class="fa fa-stop"></i> Batalkan Gambar';
        map.getCanvas().style.cursor = 'crosshair';
        setMapInteractions(false); // Disable map navigation
        
        if (drawMode === 'rectangle') {
            setStatus('Klik di peta untuk menentukan sudut awal kotak AOI...', 'info');
        } else if (drawMode === 'circle') {
            setStatus('Klik di peta untuk menentukan titik pusat lingkaran AOI...', 'info');
        } else if (drawMode === 'polygon') {
            polygonPts = [];
            setStatus('Klik di peta untuk menentukan titik sudut pertama poligon AOI...', 'info');
            document.getElementById('btn-finish-poly').style.display = 'inline-flex';
        }
        clearAoi();
    } else {
        // Cancel drawing
        resetDrawingState();
        clearAoi();
        setStatus('Penggambaran AOI dibatalkan.', 'info');
    }
};

function resetDrawingState() {
    drawState = 'idle';
    const btn = document.getElementById('draw-aoi-btn');
    if (btn) {
        btn.classList.remove('active');
        btn.innerHTML = '<i class="fa fa-pencil-ruler"></i> Mulai Menggambar';
    }
    const finishBtn = document.getElementById('btn-finish-poly');
    if (finishBtn) finishBtn.style.display = 'none';
    
    map.getCanvas().style.cursor = '';
    setMapInteractions(true); // Re-enable map navigation
}

function setMapInteractions(enabled) {
    const handlers = [
        map.dragPan,
        map.doubleClickZoom,
        map.boxZoom,
        map.dragRotate,
        map.keyboard,
        map.touchZoomRotate,
        map.touchPitch
    ];
    handlers.forEach(h => {
        if (h) {
            if (enabled) h.enable();
            else h.disable();
        }
    });
}

window.finishPolygonDrawing = function() {
    if (drawMode !== 'polygon' || drawState !== 'drawing') return;
    if (polygonPts.length < 3) {
        showToast('⚠️ Minimal poligon harus memiliki 3 titik!', 'warning');
        return;
    }
    
    // Close polygon
    polygonPts.push([polygonPts[0][0], polygonPts[0][1]]);
    drawState = 'completed';
    resetDrawingState();
    
    const areaM2 = polygonAreaM2(polygonPts);
    aoiAreaM2 = areaM2;
    const areaKm2 = areaM2 / 1000000;
    
    const aoiAreaVal = document.getElementById('aoi-area-val');
    if (aoiAreaVal) aoiAreaVal.textContent = areaKm2.toFixed(3) + ' km²';
    updateAoiEstimations(areaKm2);
    
    const clearAoiBtn = document.getElementById('btn-clear-aoi');
    if (clearAoiBtn) clearAoiBtn.style.display = 'block';
    const runBtn = document.getElementById('btn-run-analysis');
    if (runBtn) runBtn.disabled = false;
    
    setStatus(`AOI Poligon Selesai: ${areaKm2.toFixed(3)} km². Klik tombol 'Analisis' untuk memproses.`, 'success');
};

// Map click event during drawing
map.on('click', (e) => {
    if (drawState === 'idle') return;
    
    const clickCoord = [e.lngLat.lng, e.lngLat.lat];
    
    if (drawMode === 'rectangle') {
        if (drawState === 'start') {
            cornerA = clickCoord;
            drawState = 'drawing';
            setStatus('Geser mouse lalu klik sekali lagi untuk menyelesaikan kotak AOI...', 'info');
        } else if (drawState === 'drawing') {
            cornerB = clickCoord;
            drawState = 'completed';
            resetDrawingState();
            
            const areaM2 = calculateRectArea(cornerA, cornerB);
            aoiAreaM2 = areaM2;
            const areaKm2 = areaM2 / 1000000;
            
            const aoiAreaVal = document.getElementById('aoi-area-val');
            if (aoiAreaVal) aoiAreaVal.textContent = areaKm2.toFixed(3) + ' km²';
            updateAoiEstimations(areaKm2);
            
            const clearAoiBtn = document.getElementById('btn-clear-aoi');
            if (clearAoiBtn) clearAoiBtn.style.display = 'block';
            const runBtn = document.getElementById('btn-run-analysis');
            if (runBtn) runBtn.disabled = false;
            
            setStatus(`AOI Selesai: ${areaKm2.toFixed(3)} km². Klik tombol 'Analisis' untuk memproses.`, 'success');
        }
    } else if (drawMode === 'circle') {
        if (drawState === 'start') {
            circleCenter = clickCoord;
            drawState = 'drawing';
            setStatus('Geser mouse lalu klik sekali lagi untuk menentukan radius lingkaran...', 'info');
        } else if (drawState === 'drawing') {
            const currentCoord = clickCoord;
            const radiusM = getDistanceMeters(circleCenter, currentCoord);
            circleRadius = radiusM;
            drawState = 'completed';
            resetDrawingState();
            
            const areaM2 = Math.PI * radiusM * radiusM;
            aoiAreaM2 = areaM2;
            const areaKm2 = areaM2 / 1000000;
            
            const aoiAreaVal = document.getElementById('aoi-area-val');
            if (aoiAreaVal) aoiAreaVal.textContent = areaKm2.toFixed(3) + ' km²';
            updateAoiEstimations(areaKm2);
            
            const clearAoiBtn = document.getElementById('btn-clear-aoi');
            if (clearAoiBtn) clearAoiBtn.style.display = 'block';
            const runBtn = document.getElementById('btn-run-analysis');
            if (runBtn) runBtn.disabled = false;
            
            setStatus(`AOI Lingkaran Selesai: ${areaKm2.toFixed(3)} km² (Radius: ${fmt(radiusM)}m). Klik 'Analisis' untuk memproses.`, 'success');
        }
    } else if (drawMode === 'polygon') {
        if (drawState === 'start') {
            polygonPts.push(clickCoord);
            drawState = 'drawing';
            setStatus('Klik titik berikutnya untuk menggambar poligon, atau klik "Selesai"...', 'info');
        } else if (drawState === 'drawing') {
            // Check if clicking near the first point to close
            if (polygonPts.length >= 3) {
                const distToFirst = getDistanceMeters(clickCoord, polygonPts[0]);
                if (distToFirst < 15) { // within 15 meters, close it
                    finishPolygonDrawing();
                    return;
                }
            }
            polygonPts.push(clickCoord);
            setStatus(`Poligon: ${polygonPts.length} titik. Klik titik berikutnya, atau klik "Selesai" untuk mengunci.`, 'info');
        }
    }
});

// Map mousemove event during drawing (preview)
map.on('mousemove', (e) => {
    if (drawState !== 'drawing') return;
    
    const currentCoord = [e.lngLat.lng, e.lngLat.lat];
    let geometry = null;
    let areaKm2 = 0;
    let invalid = false;
    
    if (drawMode === 'rectangle' && cornerA) {
        const areaM2 = calculateRectArea(cornerA, currentCoord);
        areaKm2 = areaM2 / 1000000;
        invalid = areaKm2 > 100.0; // new limit 100 km²
        
        const coords = [
            [cornerA[0], cornerA[1]],
            [currentCoord[0], cornerA[1]],
            [currentCoord[0], currentCoord[1]],
            [cornerA[0], currentCoord[1]],
            [cornerA[0], cornerA[1]]
        ];
        geometry = {
            type: 'Polygon',
            coordinates: [coords]
        };
    } else if (drawMode === 'circle' && circleCenter) {
        const radiusM = getDistanceMeters(circleCenter, currentCoord);
        const areaM2 = Math.PI * radiusM * radiusM;
        areaKm2 = areaM2 / 1000000;
        invalid = areaKm2 > 100.0;
        geometry = createCirclePolygon(circleCenter, radiusM);
    } else if (drawMode === 'polygon' && polygonPts.length > 0) {
        const tempPts = [...polygonPts, currentCoord, polygonPts[0]];
        const areaM2 = polygonAreaM2(tempPts);
        areaKm2 = areaM2 / 1000000;
        invalid = areaKm2 > 100.0;
        geometry = {
            type: 'Polygon',
            coordinates: [tempPts]
        };
    }
    
    if (geometry && map.getSource('aoi-source')) {
        // Update size UI
        const aoiAreaVal = document.getElementById('aoi-area-val');
        if (aoiAreaVal) aoiAreaVal.textContent = areaKm2.toFixed(3) + ' km²';
        updateAoiEstimations(areaKm2);
        
        map.getSource('aoi-source').setData({
            type: 'Feature',
            properties: { invalid: invalid },
            geometry: geometry
        });
    }
});

function calculateRectArea(pt1, pt2) {
    const latAvg = (pt1[1] + pt2[1]) / 2;
    const dx = Math.abs(pt2[0] - pt1[0]) * 111320 * Math.cos(latAvg * Math.PI / 180);
    const dy = Math.abs(pt2[1] - pt1[1]) * 110540;
    return dx * dy;
}

function updateAoiEstimations(areaKm2) {
    const timeEl = document.getElementById('aoi-est-time');
    const sizeEl = document.getElementById('aoi-est-size');
    const warnEl = document.getElementById('aoi-warn-banner');
    
    if (warnEl) {
        warnEl.style.display = areaKm2 > 5.0 ? 'block' : 'none';
    }
    
    if (areaKm2 <= 0) {
        if (timeEl) timeEl.textContent = '—';
        if (sizeEl) sizeEl.textContent = '—';
        return;
    }
    
    // Heuristic estimations for data/time
    let estTime = '—';
    let estSize = '—';
    if (areaKm2 < 0.5) {
        estTime = '2 - 5 detik';
        estSize = '< 500 KB';
    } else if (areaKm2 <= 2.0) {
        estTime = '5 - 10 detik';
        estSize = '500 KB - 2 MB';
    } else if (areaKm2 <= 5.0) {
        estTime = '10 - 20 detik';
        estSize = '2 - 6 MB';
    } else if (areaKm2 <= 20.0) {
        estTime = '20 - 40 detik';
        estSize = '6 - 20 MB';
    } else {
        estTime = '> 60 detik (Sangat Lama)';
        estSize = '> 20 MB (Sangat Berat)';
    }
    
    if (timeEl) timeEl.textContent = estTime;
    if (sizeEl) sizeEl.textContent = estSize;

    // Enable/disable analysis button based on 100km2 limit
    const runBtn = document.getElementById('btn-run-analysis');
    if (runBtn && drawState === 'completed') {
        runBtn.disabled = (areaKm2 > 100.0 || areaKm2 <= 0);
    }
}

window.clearAoi = function() {
    cornerA = null;
    cornerB = null;
    circleCenter = null;
    circleRadius = 0;
    polygonPts = [];
    aoiAreaM2 = 0;
    
    const aoiAreaVal = document.getElementById('aoi-area-val');
    if (aoiAreaVal) aoiAreaVal.textContent = '—';
    const estTime = document.getElementById('aoi-est-time');
    if (estTime) estTime.textContent = '—';
    const estSize = document.getElementById('aoi-est-size');
    if (estSize) estSize.textContent = '—';
    const warnBanner = document.getElementById('aoi-warn-banner');
    if (warnBanner) warnBanner.style.display = 'none';
    const runBtn = document.getElementById('btn-run-analysis');
    if (runBtn) runBtn.disabled = true;
    const clearBtn = document.getElementById('btn-clear-aoi');
    if (clearBtn) clearBtn.style.display = 'none';
    
    if (map.getSource('aoi-source')) {
        map.getSource('aoi-source').setData({
            type: 'FeatureCollection',
            features: []
        });
    }
    
    // Remove buildings if loaded
    clearBuildingsLayers();
    const statsDashboard = document.getElementById('stats-dashboard');
    if (statsDashboard) statsDashboard.style.display = 'none';
    const saveProjectBtn = document.getElementById('save-project-btn');
    if (saveProjectBtn) saveProjectBtn.disabled = true;
    closeDetail();
};

function clearBuildingsLayers() {
    ['buildings-labels','buildings-3d','buildings-outline']
        .forEach(id => { try { if (map.getLayer(id)) map.removeLayer(id); } catch(_){} });
    try { if (map.getSource('buildings-source')) map.removeSource('buildings-source'); } catch(_){}
    allGeojsonData = null;
    geojsonData = null;
}

// ============================================================
//  OVERPASS API FETCH & GEOMETRY PARSER
// ============================================================
window.runAnalysis = async function() {
    if (drawMode === 'rectangle' && (!cornerA || !cornerB)) return;
    if (drawMode === 'circle' && (!circleCenter || !circleRadius)) return;
    if (drawMode === 'polygon' && polygonPts.length < 3) return;
    if (analysisState.active) return;

    const runBtn = document.getElementById('btn-run-analysis');
    const clearBtn = document.getElementById('btn-clear-aoi');
    const cancelBtn = document.getElementById('btn-cancel-analysis');
    const loaderWrap = document.getElementById('aoi-loader-wrap');
    const loaderStatus = document.getElementById('aoi-loader-status');
    const loaderPct = document.getElementById('aoi-loader-pct');
    const loaderBar = document.getElementById('aoi-loader-bar');
    const loaderTime = document.getElementById('aoi-loader-time');
    const loaderSize = document.getElementById('aoi-loader-size');

    const areaKm2 = aoiAreaM2 / 1000000;
    if (areaKm2 <= 0) {
        setStatus('AOI tidak valid. Silakan gambarkan ulang area.', 'error');
        showToast('⚠️ AOI tidak valid!', 'error');
        return;
    }

    if (areaKm2 > 10 && !confirm('Area analisis sangat besar. Proses pengunduhan data OSM akan memakan waktu lebih lama. Lanjutkan?')) {
        setStatus('Analisis dibatalkan oleh pengguna karena area besar.', 'info');
        return;
    }

    analysisState.active = true;
    analysisState.cancelled = false;
    analysisState.controller = new AbortController();

    if (runBtn) runBtn.disabled = true;
    if (clearBtn) clearBtn.disabled = true;
    if (cancelBtn) cancelBtn.style.display = 'inline-flex';
    if (loaderWrap) loaderWrap.style.display = 'block';
    
    const estTimeEl = document.getElementById('aoi-est-time');
    if (loaderTime && estTimeEl) loaderTime.textContent = estTimeEl.textContent;
    const estSizeEl = document.getElementById('aoi-est-size');
    if (loaderSize && estSizeEl) loaderSize.textContent = estSizeEl.textContent;

    // reset queue first, then show overlay so queue list displays as a grid
    resetAnalysisQueue();
    showAnalysisOverlay();
    
    updateAnalysisSummary(areaKm2);
    updateAnalysisCounts();
    updateAnalysisDataEstimate();
    updateAnalysisQueue('aoi-validated', 'AOI siap divalidasi', 'active');
    setAnalysisStage('validate', 'Memeriksa validitas AOI...', 'active');
    setStatus('Validating AOI area...', 'info');
    if (loaderPct) loaderPct.textContent = '0%';
    if (loaderBar) loaderBar.style.width = '0%';

    const updateLoader = (message) => {
        if (loaderStatus) {
            loaderStatus.innerHTML = `<i class="fa fa-circle-notch fa-spin"></i> ${message}`;
        }
    };

    try {
        if (analysisState.cancelled) throw new Error('cancelled');

        updateAnalysisQueue('aoi-validated', 'AOI divalidasi', 'done');
        updateAnalysisQueue('aoi-area', 'Luas AOI dihitung', 'active');
        setAnalysisStage('validate', 'AOI valid.', 'done');
        setAnalysisStage('connect', 'Menyambung ke Overpass API...', 'active');
        updateLoader('Menyambung ke Overpass API...');

        // Calculate bounding box and write the Overpass query dynamically
        let minLat, minLon, maxLat, maxLon, query;
        if (drawMode === 'rectangle') {
            minLat = Math.min(cornerA[1], cornerB[1]);
            minLon = Math.min(cornerA[0], cornerB[0]);
            maxLat = Math.max(cornerA[1], cornerB[1]);
            maxLon = Math.max(cornerA[0], cornerB[0]);
            query = `[out:json][timeout:90];\n(\n  way["building"](${minLat},${minLon},${maxLat},${maxLon});\n  relation["building"](${minLat},${minLon},${maxLat},${maxLon});\n);\nout geom;`;
        } else if (drawMode === 'circle') {
            const deltaLat = circleRadius / 110540;
            const deltaLon = circleRadius / (111320 * Math.cos(circleCenter[1] * Math.PI / 180));
            minLat = circleCenter[1] - deltaLat;
            minLon = circleCenter[0] - deltaLon;
            maxLat = circleCenter[1] + deltaLat;
            maxLon = circleCenter[0] + deltaLon;
            query = `[out:json][timeout:90];\n(\n  way["building"](around:${circleRadius},${circleCenter[1]},${circleCenter[0]});\n  relation["building"](around:${circleRadius},${circleCenter[1]},${circleCenter[0]});\n);\nout geom;`;
        } else if (drawMode === 'polygon') {
            const lats = polygonPts.map(p => p[1]);
            const lons = polygonPts.map(p => p[0]);
            minLat = Math.min(...lats);
            minLon = Math.min(...lons);
            maxLat = Math.max(...lats);
            maxLon = Math.max(...lons);
            query = `[out:json][timeout:90];\n(\n  way["building"](${minLat},${minLon},${maxLat},${maxLon});\n  relation["building"](${minLat},${minLon},${maxLat},${maxLon});\n);\nout geom;`;
        }

        // Official Overpass interpreter mirrors prioritized first
        const endpoints = [
            'https://overpass-api.de/api/interpreter',
            'https://overpass.openstreetmap.fr/api/interpreter'
        ];

        let rawResponse = null;
        let lastError = null;
        for (let i = 0; i < endpoints.length && !analysisState.cancelled; i++) {
            const serverLabel = `Server ${i + 1}/${endpoints.length}`;
            updateLoader(`Mengambil data OSM dari ${serverLabel}...`);
            setAnalysisStage('connect', `Mengambil data dari ${serverLabel}`, 'active');
            updateAnalysisQueue('osm-download', `Menjalankan request ${i + 1}/${endpoints.length}`, 'active');

            try {
                // Use POST request which is faster and more robust
                rawResponse = await fetchWithRetry(endpoints[i], {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded'
                    },
                    body: `data=${encodeURIComponent(query)}`,
                    signal: analysisState.controller.signal
                }, 15000, 1); // 15 seconds timeout per request, 1 retry
                break;
            } catch (err) {
                lastError = err;
                console.warn(`[Overpass] ${serverLabel} gagal:`, err.message);
                if (analysisState.cancelled) break;
            }
        }

        if (analysisState.cancelled) {
            throw new Error('cancelled');
        }

        if (!rawResponse) {
            throw new Error('overpass_unavailable');
        }

        updateAnalysisQueue('osm-download', 'Download data selesai', 'done');
        setAnalysisStage('connect', 'Koneksi OSM berhasil.', 'done');
        setAnalysisStage('download', 'Menerima data bangunan...', 'active');
        updateLoader('Menerima data bangunan...');
        updateAnalysisCounts();

        const rawGeojson = overpassToGeoJSON(rawResponse);
        
        // Client-side clipping for Circle and Polygon modes
        if (drawMode === 'circle') {
            rawGeojson.features = rawGeojson.features.filter(f => {
                if (!f.geometry || !f.geometry.coordinates) return false;
                let center = [0,0];
                if (f.geometry.type === 'Polygon') {
                    center = f.geometry.coordinates[0][0];
                } else if (f.geometry.type === 'MultiPolygon') {
                    center = f.geometry.coordinates[0][0][0];
                }
                return getDistanceMeters(circleCenter, center) <= circleRadius;
            });
        } else if (drawMode === 'polygon') {
            rawGeojson.features = rawGeojson.features.filter(f => {
                if (!f.geometry || !f.geometry.coordinates) return false;
                let center = [0,0];
                if (f.geometry.type === 'Polygon') {
                    center = f.geometry.coordinates[0][0];
                } else if (f.geometry.type === 'MultiPolygon') {
                    center = f.geometry.coordinates[0][0][0];
                }
                return isPointInPolygon(center, polygonPts);
            });
        }

        const count = rawGeojson.features.length;
        if (count === 0) {
            throw new Error('empty_osm_response');
        }

        setAnalysisStage('download', 'Data footprint diunduh.', 'done');
        setAnalysisStage('process', 'Memproses geometri bangunan...', 'active');
        updateAnalysisQueue('solar-analysis', 'Analisis solar menunggu', 'pending');
        updateLoader('Memproses geometri bangunan...');

        allGeojsonData = enrichFeatures(rawGeojson);
        updateAnalysisCounts(count);
        updateAnalysisQueue('aoi-area', `Area ${fmt(areaKm2, 3)} km²`, 'done');
        updateAnalysisQueue('osm-download', `${count} bangunan diterima`, 'done');
        updateAnalysisQueue('solar-analysis', 'Menganalisis potensi solar', 'active');
        updateAnalysisQueue('3d-rendering', 'Menunggu rendering', 'pending');

        if (analysisState.cancelled) {
            throw new Error('cancelled');
        }

        setAnalysisStage('process', 'Geometri diproses.', 'done');
        updateLoader('Menghitung potensi solar dan reduksi CO₂...');

        // Finalize base variables, then run filter and paint
        setAnalysisStage('solar', 'Potensi solar dihitung.', 'done');
        updateLoader('Menyiapkan visualisasi 3D...');
        updateAnalysisQueue('solar-analysis', 'Analisis solar selesai', 'done');
        updateAnalysisQueue('3d-rendering', 'Membuat visualisasi 3D', 'active');

        // Apply filters internally maps to the map layers and global data
        applyFilters();
        fitCameraToAoi(minLon, minLat, maxLon, maxLat);

        setAnalysisStage('visualize', 'Visualisasi 3D siap.', 'done');
        updateAnalysisQueue('3d-rendering', 'Rendering 3D selesai', 'done');
        setAnalysisStage('finalize', 'Menyiapkan hasil akhir...', 'active');
        updateLoader('Finalizing results...');
        await waitFor(250);

        setAnalysisStage('finalize', 'Selesai.', 'done');
        const progressInner = document.getElementById('analysis-progress-inner');
        if (progressInner) progressInner.style.width = '100%';
        updateLoader('Analisis selesai!');
        setStatus(`Selesai! ${fmt(count)} bangunan dianalisis.`, 'success');
        showToast(`✅ ${fmt(count)} bangunan dimuat!`, 'success');
        const saveProjectBtn = document.getElementById('save-project-btn');
        if (saveProjectBtn) saveProjectBtn.disabled = false;
    } catch (error) {
        if (error.message === 'cancelled') {
            setStatus('Analisis dibatalkan oleh pengguna.', 'info');
            showToast('Analisis dibatalkan oleh pengguna.', 'info');
            setAnalysisStage(analysisState.currentStage || 'validate', 'Dibatalkan.', 'cancelled');
            updateAnalysisQueue('osm-download', 'Dibatalkan', 'cancelled');
        } else if (error.message === 'empty_osm_response') {
            setStatus('Area tidak memiliki bangunan OSM yang dapat diproses.', 'error');
            showToast('⚠️ Tidak ada bangunan ditemukan di area tersebut.', 'error');
            setAnalysisStage('download', 'Respon kosong dari OSM.', 'error');
            updateAnalysisQueue('osm-download', 'Tidak ada data bangunan', 'error');
        } else if (error.message === 'overpass_unavailable') {
            setStatus('Tidak dapat terhubung ke Overpass API. Silakan coba lagi.', 'error');
            showToast('⚠️ Koneksi Overpass gagal.', 'error');
            setAnalysisStage('connect', 'Koneksi Overpass gagal.', 'error');
            updateAnalysisQueue('osm-download', 'Gagal mengunduh data', 'error');
        } else {
            console.error('[Analysis Error]', error);
            setStatus(`Kesalahan analisis: ${error.message}`, 'error');
            showToast('❌ Terjadi kesalahan saat analisis.', 'error');
            setAnalysisStage(analysisState.currentStage || 'validate', 'Kesalahan terjadi.', 'error');
        }
    } finally {
        analysisState.active = false;
        analysisState.controller = null;
        analysisState.cancelled = false;
        if (runBtn) runBtn.disabled = false;
        if (clearBtn) clearBtn.disabled = false;
        if (cancelBtn) cancelBtn.style.display = 'none';
        
        // DO NOT hide overlay automatically so the user can inspect progress details and close manually.
        if (loaderWrap) loaderWrap.style.display = 'none';
    }
};

function overpassToGeoJSON(overpassJson) {
    const features = [];
    if (!overpassJson || !overpassJson.elements) return { type: 'FeatureCollection', features: [] };

    overpassJson.elements.forEach(el => {
        if (el.type === 'way' && el.geometry && el.geometry.length >= 3) {
            const coords = el.geometry.map(pt => [pt.lon, pt.lat]);
            if (coords[0][0] !== coords[coords.length-1][0] || coords[0][1] !== coords[coords.length-1][1]) {
                coords.push([coords[0][0], coords[0][1]]);
            }
            const tags = el.tags || {};
            const levels = parseInt(tags['building:levels'] || tags.levels || Math.round(parseFloat(tags.height || 0) / 3.5) || 1);
            features.push({
                type: 'Feature',
                id: el.id,
                properties: {
                    id: el.id,
                    name: tags.name || tags['name:id'] || tags['name:en'] || `Gedung OSM-${el.id}`,
                    building: tags.building || 'building',
                    levels: levels,
                    height: parseFloat(tags.height) || (levels * 3.5)
                },
                geometry: {
                    type: 'Polygon',
                    coordinates: [coords]
                }
            });
        } else if (el.type === 'relation' && el.members) {
            const outerMembers = el.members.filter(m => m.role === 'outer' && m.geometry && m.geometry.length >= 3);
            outerMembers.forEach((m, idx) => {
                const coords = m.geometry.map(pt => [pt.lon, pt.lat]);
                if (coords[0][0] !== coords[coords.length-1][0] || coords[0][1] !== coords[coords.length-1][1]) {
                    coords.push([coords[0][0], coords[0][1]]);
                }
                const tags = el.tags || {};
                const levels = parseInt(tags['building:levels'] || tags.levels || Math.round(parseFloat(tags.height || 0) / 3.5) || 1);
                features.push({
                    type: 'Feature',
                    id: `${el.id}-${idx}`,
                    properties: {
                        id: `${el.id}-${idx}`,
                        name: tags.name || tags['name:id'] || tags['name:en'] || `Gedung OSM-${el.id}`,
                        building: tags.building || 'building',
                        levels: levels,
                        height: parseFloat(tags.height) || (levels * 3.5)
                    },
                    geometry: {
                        type: 'Polygon',
                        coordinates: [coords]
                    }
                });
            });
        }
    });

    return { type: 'FeatureCollection', features: features };
}

function polygonAreaM2(coords) {
    const toRad = d => d * Math.PI / 180;
    let area = 0;
    const n = coords.length;
    for (let i = 0; i < n; i++) {
        const [x1, y1] = coords[i];
        const [x2, y2] = coords[(i + 1) % n];
        area += (toRad(x2) - toRad(x1)) * (2 + Math.sin(toRad(y1)) + Math.sin(toRad(y2)));
    }
    return Math.abs(area * 6378137 * 6378137 / 2);
}

function enrichFeatures(data) {
    const globalCoverage   = parseInt(document.getElementById('sl-global-coverage').value) / 100;
    const globalEfficiency  = parseInt(document.getElementById('sl-global-efficiency').value) / 100;
    const globalIrradiance  = parseInt(document.getElementById('sl-global-irradiance').value);

    data.features.forEach(f => {
        if (!f.properties) f.properties = {};
        
        // Calculate roof area via Shoelace
        if (!f.properties.area_m2 && f.geometry) {
            let coords = [];
            if (f.geometry.type === 'Polygon') coords = f.geometry.coordinates[0];
            else if (f.geometry.type === 'MultiPolygon') coords = f.geometry.coordinates[0][0];
            if (coords.length) f.properties.area_m2 = Math.round(polygonAreaM2(coords));
        }
        
        // Base calculations
        const area = f.properties.area_m2 || 10;
        f.properties.energy_kwh = Math.round(area * globalCoverage * globalIrradiance * globalEfficiency * PERF_RATIO);
    });
    return data;
}

// ============================================================
//  FILTER & DYNAMIC RENDERING
// ============================================================
window.applyFilters = function() {
    if (!allGeojsonData) return { type: 'FeatureCollection', features: [] };
    
    const minLevels = parseInt(document.getElementById('sl-min-levels').value);
    const globalCoverage   = parseInt(document.getElementById('sl-global-coverage').value) / 100;
    const globalEfficiency  = parseInt(document.getElementById('sl-global-efficiency').value) / 100;
    const globalIrradiance  = parseInt(document.getElementById('sl-global-irradiance').value);
    
    // Deep copy parameters & recalculate
    const filteredFeatures = allGeojsonData.features
        .filter(f => f.properties.levels >= minLevels)
        .map(f => {
            const area = f.properties.area_m2 || 10;
            const energy = Math.round(area * globalCoverage * globalIrradiance * globalEfficiency * PERF_RATIO);
            return {
                ...f,
                properties: {
                    ...f.properties,
                    energy_kwh: energy
                }
            };
        });
        
    geojsonData = {
        type: 'FeatureCollection',
        features: filteredFeatures
    };
    
    // Render 3D and update stats dashboard
    renderBuildingsLayer(geojsonData);
    updateStatsDashboard(geojsonData);

    return geojsonData;
};

window.updateParametersUI = function() {
    const valMinLevels = document.getElementById('val-min-levels');
    if (valMinLevels) valMinLevels.textContent = document.getElementById('sl-min-levels').value;
    
    const valGlobalCoverage = document.getElementById('val-global-coverage');
    if (valGlobalCoverage) valGlobalCoverage.textContent = document.getElementById('sl-global-coverage').value + '%';
    
    const valGlobalEfficiency = document.getElementById('val-global-efficiency');
    if (valGlobalEfficiency) valGlobalEfficiency.textContent = document.getElementById('sl-global-efficiency').value + '%';
    
    const valGlobalIrradiance = document.getElementById('val-global-irradiance');
    if (valGlobalIrradiance) valGlobalIrradiance.textContent = document.getElementById('sl-global-irradiance').value;
    
    // Instantly recalculate & render on parameter slide
    applyFilters();
    
    // If sidebar is open, update simulator values
    if (currentFeature) {
        updateSim();
    }
};

function renderBuildingsLayer(data) {
    // Cleanup old layer
    ['buildings-labels','buildings-3d','buildings-outline']
        .forEach(id => { try { if (map.getLayer(id)) map.removeLayer(id); } catch(_){} });
    try { if (map.getSource('buildings-source')) map.removeSource('buildings-source'); } catch(_){}
    
    // Add fresh geojson source
    map.addSource('buildings-source', { type: 'geojson', data, generateId: true });
    
    // 3D Extrusion
    map.addLayer({
        id: 'buildings-3d',
        type: 'fill-extrusion',
        source: 'buildings-source',
        paint: {
            'fill-extrusion-height': [
                '*', ['coalesce', ['get', 'levels'], 1], 3.5
            ],
            'fill-extrusion-base': 0,
            // Color scale based on energy_kwh
            'fill-extrusion-color': [
                'interpolate', ['linear'],
                ['coalesce', ['get', 'energy_kwh'], 100],
                0,      '#3b82f6',   // Blue
                5000,   '#06b6d4',   // Cyan
                15000,  '#10b981',   // Green
                30000,  '#f59e0b',   // Amber
                60000,  '#ef4444'    // Red
            ],
            'fill-extrusion-opacity': 0.92,
            'fill-extrusion-vertical-gradient': true
        }
    });
    
    // Outline
    map.addLayer({
        id: 'buildings-outline',
        type: 'line',
        source: 'buildings-source',
        paint: {
            'line-color': 'rgba(148, 210, 255, 0.45)',
            'line-width': 1
        }
    });
    
    setupBuildingInteractions();
}

function updateStatsDashboard(data) {
    const count = data.features.length;
    const statsDashboard = document.getElementById('stats-dashboard');
    if (statsDashboard) statsDashboard.style.display = count > 0 ? 'block' : 'none';
    
    if (count === 0) return;
    
    let totalArea = 0;
    let totalEnergy = 0;
    
    data.features.forEach(f => {
        totalArea += f.properties.area_m2 || 0;
        totalEnergy += f.properties.energy_kwh || 0;
    });
    
    const totalEnergyMwh = totalEnergy / 1000;
    const totalCo2Tons = totalEnergy * CO2_KG_PER_KWH / 1000;
    
    const statBuildings = document.getElementById('stat-buildings');
    if (statBuildings) statBuildings.textContent = fmt(count);
    
    const statArea = document.getElementById('stat-area');
    if (statArea) statArea.textContent = fmt(totalArea);
    
    const statEnergy = document.getElementById('stat-energy');
    if (statEnergy) statEnergy.textContent = fmt(totalEnergyMwh, 1);
    
    const statCo2 = document.getElementById('stat-co2');
    if (statCo2) statCo2.textContent = fmt(totalCo2Tons, 1);
    
    // Rebuild Top 5 Potential buildings
    const sorted = [...data.features]
        .sort((a,b) => (b.properties.energy_kwh || 0) - (a.properties.energy_kwh || 0))
        .slice(0, 5);
        
    const container = document.getElementById('top-buildings-container');
    if (container) {
        container.innerHTML = '';
        
        if (sorted.length > 0) {
            const maxEnergy = sorted[0].properties.energy_kwh || 1;
            sorted.forEach(f => {
                const p = f.properties;
                const pct = Math.min(100, Math.round((p.energy_kwh / maxEnergy) * 100));
                
                const div = document.createElement('div');
                div.className = 'top-item';
                div.innerHTML = `
                    <div class="top-item-header">
                        <span style="color:var(--white);">${p.name}</span>
                        <span style="color:var(--amber-400);">${fmt(p.energy_kwh)} kWh/thn</span>
                    </div>
                    <div class="top-item-stats">
                        <span>Lantai: ${p.levels} | Luas: ${fmt(p.area_m2)} m²</span>
                        <span>CO₂: -${fmt(p.energy_kwh * CO2_KG_PER_KWH)} kg</span>
                    </div>
                    <div class="top-item-bar-bg">
                        <div class="top-item-bar" style="width: ${pct}%;"></div>
                    </div>
                `;
                div.style.cursor = 'pointer';
                div.onclick = () => selectBuildingFeature(f);
                container.appendChild(div);
            });
        }
    }
}

function fitCameraToAoi(minLon, minLat, maxLon, maxLat) {
    map.fitBounds([
        [minLon, minLat],
        [maxLon, maxLat]
    ], {
        padding: 50,
        duration: 1500,
        essential: true
    });
    
    setTimeout(() => {
        map.flyTo({
            pitch: 60,
            bearing: -15,
            duration: 1000
        });
    }, 1600);
}

// ============================================================
//  INTERACTIVE ACTIONS (Hover & Click)
// ============================================================
let hoveredId = null;
let interactionsSetup = false;

function setupBuildingInteractions() {
    // Prevent duplicate event listener registrations
    if (interactionsSetup) return;
    interactionsSetup = true;

    map.on('mousemove', 'buildings-3d', (e) => {
        map.getCanvas().style.cursor = 'pointer';
        const f = e.features[0];
        
        if (hoveredId !== null) map.setFeatureState({ source: 'buildings-source', id: hoveredId }, { hover: false });
        hoveredId = f.id;
        map.setFeatureState({ source: 'buildings-source', id: hoveredId }, { hover: true });

        const p = f.properties || {};
        const tt = document.getElementById('hover-tooltip');
        if (tt) {
            tt.style.display = 'block';
            tt.style.left = (e.point.x + 12) + 'px';
            tt.style.top  = (e.point.y - 10) + 'px';
        }
        
        const htName = document.getElementById('ht-name');
        if (htName) htName.textContent   = p.name || 'Gedung';
        const htLevels = document.getElementById('ht-levels');
        if (htLevels) htLevels.textContent = (p.levels || 1) + ' lantai';
        const htArea = document.getElementById('ht-area');
        if (htArea) htArea.textContent = fmt(p.area_m2 || 0) + ' m²';
        const htEnergy = document.getElementById('ht-energy');
        if (htEnergy) htEnergy.textContent = fmt(p.energy_kwh || 0) + ' kWh';
    });
    
    map.on('mouseleave', 'buildings-3d', () => {
        map.getCanvas().style.cursor = '';
        if (hoveredId !== null) map.setFeatureState({ source: 'buildings-source', id: hoveredId }, { hover: false });
        hoveredId = null;
        const tt = document.getElementById('hover-tooltip');
        if (tt) tt.style.display = 'none';
    });
    
    map.on('click', 'buildings-3d', (e) => {
        const f = e.features[0];
        selectBuildingFeature(f);
    });
}

function selectBuildingFeature(feature) {
    currentFeature = feature;
    const p = feature.properties || {};
    currentArea = p.area_m2 || 10;
    
    const bName = document.getElementById('detail-building-name');
    if (bName) bName.textContent = p.name || 'Gedung Tanpa Nama';
    const bType = document.getElementById('detail-building-type');
    if (bType) bType.textContent = (p.building || 'building').toUpperCase();
    
    const dLevels = document.getElementById('d-levels');
    if (dLevels) dLevels.textContent = (p.levels || 1) + ' lantai';
    const dHeight = document.getElementById('d-height');
    if (dHeight) dHeight.textContent = (p.height || (p.levels*3.5)).toFixed(1) + ' m';
    const dArea = document.getElementById('d-area');
    if (dArea) dArea.textContent = fmt(currentArea) + ' m²';
    const dEnergy = document.getElementById('d-energy');
    if (dEnergy) dEnergy.textContent = fmt(p.energy_kwh || 0) + ' kWh/thn';
    const dCo2 = document.getElementById('d-co2');
    if (dCo2) dCo2.textContent = fmt((p.energy_kwh || 0) * CO2_KG_PER_KWH) + ' kg/thn';
    
    const slCoverage = document.getElementById('sl-coverage');
    const slGlobalCoverage = document.getElementById('sl-global-coverage');
    if (slCoverage && slGlobalCoverage) slCoverage.value = slGlobalCoverage.value;
    
    const slEfficiency = document.getElementById('sl-efficiency');
    const slGlobalEfficiency = document.getElementById('sl-global-efficiency');
    if (slEfficiency && slGlobalEfficiency) slEfficiency.value = slGlobalEfficiency.value;
    
    const rightPanel = document.getElementById('right-panel');
    if (rightPanel) rightPanel.classList.add('open');
    updateSim();
    
    let center = [0, 0];
    if (feature.geometry) {
        const g = feature.geometry;
        if (g.type === 'Polygon') center = g.coordinates[0][0];
        else if (g.type === 'MultiPolygon') center = g.coordinates[0][0][0];
    }
    if (center[0] !== 0) {
        map.flyTo({ center, zoom: Math.max(map.getZoom(), 16), pitch: 65, duration: 1000 });
    }
}

window.closeDetail = function() {
    const rightPanel = document.getElementById('right-panel');
    if (rightPanel) rightPanel.classList.remove('open');
    currentFeature = null;
};

// Solar simulator for clicked building
window.updateSim = function() {
    if (!currentFeature) return;
    
    const coverage   = parseInt(document.getElementById('sl-coverage').value);
    const efficiency = parseInt(document.getElementById('sl-efficiency').value);
    const irradiance = parseInt(document.getElementById('sl-global-irradiance').value);
    
    const valCoverage = document.getElementById('val-coverage');
    if (valCoverage) valCoverage.textContent = coverage + '%';
    const valEfficiency = document.getElementById('val-efficiency');
    if (valEfficiency) valEfficiency.textContent = efficiency + '%';
    
    const area = currentArea || 10;
    const energy = area * (coverage/100) * irradiance * (efficiency/100) * PERF_RATIO;
    const saving = energy * TARIFF_IDR;
    const co2    = energy * CO2_KG_PER_KWH;
    
    const capacityWp = area * (coverage/100) * (efficiency/100) * 1000;
    const investment = capacityWp * COST_PER_WP;
    const roi = saving > 0 ? (investment / saving) : 0;
    
    const outEnergy = document.getElementById('out-energy');
    if (outEnergy) outEnergy.textContent = fmt(energy, 0);
    const outSaving = document.getElementById('out-saving');
    if (outSaving) outSaving.textContent = fmtIDR(saving);
    const outCo2 = document.getElementById('out-co2');
    if (outCo2) outCo2.textContent = fmt(co2, 0) + ' kg';
    const outRoi = document.getElementById('out-roi');
    if (outRoi) outRoi.textContent = roi > 0 ? fmt(roi, 1) + ' thn' : '—';
};

// ============================================================
//  EXPORTS SECTION
// ============================================================
window.exportGeoJSON = function() {
    if (!geojsonData) return;
    const blob = new Blob([JSON.stringify(geojsonData, null, 2)], { type: 'application/geojson;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `SolarCadastre_Potensi_3D_${Date.now()}.geojson`;
    a.click();
    showToast('📂 GeoJSON berhasil diekspor!', 'success');
};

window.exportCSV = function() {
    if (!geojsonData) return;
    let csv = 'id_osm;nama_gedung;jumlah_lantai;luas_atap_m2;energi_kwh_tahun;reduksi_co2_kg_tahun\n';
    
    geojsonData.features.forEach(f => {
        const p = f.properties;
        csv += `"${p.id}";"${p.name}";${p.levels};${p.area_m2};${p.energy_kwh};${(p.energy_kwh*CO2_KG_PER_KWH).toFixed(1)}\n`;
    });
    
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `SolarCadastre_Analisis_${Date.now()}.csv`;
    a.click();
    showToast('📋 CSV berhasil diekspor!', 'success');
};

window.exportLaporan = function() {
    if (!geojsonData) return;
    
    let totalArea = 0;
    let totalEnergy = 0;
    geojsonData.features.forEach(f => {
        totalArea += f.properties.area_m2 || 0;
        totalEnergy += f.properties.energy_kwh || 0;
    });
    const totalEnergyMwh = totalEnergy / 1000;
    const totalCo2Tons = totalEnergy * CO2_KG_PER_KWH / 1000;
    const valueRupiah = totalEnergy * TARIFF_IDR;

    const report = `==========================================================
LAPORAN ANALISIS POTENSI ENERGI SURYA 3D (SOLARCADASTRE)
==========================================================
Dihasilkan pada: ${new Date().toLocaleString('id-ID')}
Cakupan Wilayah: Area of Interest (OSM)
Jumlah Bangunan Teranalisis: ${geojsonData.features.length} gedung
Total Luas Area Atap: ${totalArea.toLocaleString('id-ID')} m²

ESTIMASI OUTPUT SURYA:
----------------------------------------------------------
1. Total Potensi Energi: ${totalEnergyMwh.toLocaleString('id-ID', {maximumFractionDigits: 2})} MWh / tahun
2. Total Penghematan Finansial: ${fmtIDR(valueRupiah)} / tahun
3. Total Reduksi Emisi CO2: ${totalCo2Tons.toLocaleString('id-ID', {maximumFractionDigits: 2})} ton / tahun

PARAMETER ANALISIS GLOBAL:
- Min. Lantai Gedung: ${document.getElementById('sl-min-levels').value} lantai
- Cakupan Panel Atap: ${document.getElementById('sl-global-coverage').value}%
- Efisiensi Solar Panel: ${document.getElementById('sl-global-efficiency').value}%
- Rata-rata Radiasi Matahari: ${document.getElementById('sl-global-irradiance').value} kWh/m²/tahun
- Solar Performance Ratio: 75.0%

Dihasilkan secara otomatis oleh SolarCadastre 3D Indonesia.
==========================================================`;

    const blob = new Blob([report], { type: 'text/plain;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `SolarCadastre_Laporan_${Date.now()}.txt`;
    a.click();
    showToast('📝 Laporan TXT berhasil diekspor!', 'success');
};

// ============================================================
//  PROJECT LIBRARY & SUPABASE STORAGE
// ============================================================

// Load local projects from localStorage
function loadLocalProjects() {
    try {
        const raw = localStorage.getItem('solarcadastre_local_projects');
        localProjects = raw ? JSON.parse(raw) : [];
    } catch(e) {
        console.error('Gagal memuat local storage projects:', e);
        localProjects = [];
    }
    renderProjectList();
}

// Render list of projects in sidebar
function renderProjectList() {
    const container = document.getElementById('project-list-container');
    if (!container) return;
    container.innerHTML = '';
    
    let displayList = [...localProjects];
    
    if (displayList.length === 0) {
        container.innerHTML = '<div class="no-projects">Belum ada project tersimpan</div>';
        return;
    }
    
    displayList.forEach((p, idx) => {
        const item = document.createElement('div');
        item.className = 'project-item';
        
        const nameBtn = document.createElement('button');
        nameBtn.className = 'project-name-btn';
        nameBtn.innerHTML = `<i class="fa fa-map"></i> ${p.name}`;
        nameBtn.onclick = () => loadProject(p);
        
        const delBtn = document.createElement('button');
        delBtn.className = 'project-delete-btn';
        delBtn.innerHTML = '<i class="fa fa-trash-can"></i>';
        delBtn.onclick = () => deleteProject(p.id || idx, p.isCloud);
        
        item.appendChild(nameBtn);
        item.appendChild(delBtn);
        container.appendChild(item);
    });
}

async function fetchCloudProjects() {
    if (!supabase || !userSession) return;
    try {
        const { data, error } = await supabase
            .from('projects')
            .select('*')
            .order('created_at', { ascending: false });
            
        if (error) throw error;
        
        const cloudProjects = (data || []).map(p => ({
            id: p.id,
            name: p.name + ' ☁️',
            isCloud: true,
            aoi_geojson: p.aoi_geojson,
            geojson_data: p.geojson_data,
            solar_stats: p.solar_stats
        }));
        
        const merged = [...cloudProjects, ...localProjects];
        renderMergedProjectList(merged);
    } catch (err) {
        console.warn('[Library] Table projects mungkin belum dibuat:', err.message);
        loadLocalProjects();
    }
}

function renderMergedProjectList(list) {
    const container = document.getElementById('project-list-container');
    if (!container) return;
    container.innerHTML = '';
    if (list.length === 0) {
        container.innerHTML = '<div class="no-projects">Belum ada project tersimpan</div>';
        return;
    }
    list.forEach((p) => {
        const item = document.createElement('div');
        item.className = 'project-item';
        
        const nameBtn = document.createElement('button');
        nameBtn.className = 'project-name-btn';
        nameBtn.innerHTML = `<i class="fa fa-map"></i> ${p.name}`;
        nameBtn.onclick = () => loadProject(p);
        
        const delBtn = document.createElement('button');
        delBtn.className = 'project-delete-btn';
        delBtn.innerHTML = '<i class="fa fa-trash-can"></i>';
        delBtn.onclick = () => deleteProject(p.id, p.isCloud);
        
        item.appendChild(nameBtn);
        item.appendChild(delBtn);
        container.appendChild(item);
    });
}

// Save current analysis to library
window.saveCurrentProject = async function() {
    const nameInput = document.getElementById('new-project-name');
    if (!nameInput) return;
    const name = nameInput.value.trim();
    if (!name) { showToast('⚠️ Harap masukkan nama project!', 'error'); return; }
    
    const hasAoi = (drawMode === 'rectangle' && cornerA && cornerB) || 
                    (drawMode === 'circle' && circleCenter && circleRadius) || 
                    (drawMode === 'polygon' && polygonPts.length >= 3);
                    
    if (!allGeojsonData || !hasAoi) { showToast('⚠️ Lakukan analisis terlebih dahulu!', 'error'); return; }
    
    const saveBtn = document.getElementById('save-project-btn');
    if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.innerHTML = '<i class="fa fa-circle-notch fa-spin"></i>';
    }

    let aoiGeoJSON = null;
    if (drawMode === 'rectangle') {
        aoiGeoJSON = {
            type: 'Feature',
            properties: { drawMode: 'rectangle' },
            geometry: {
                type: 'Polygon',
                coordinates: [[
                    [cornerA[0], cornerA[1]],
                    [cornerB[0], cornerA[1]],
                    [cornerB[0], cornerB[1]],
                    [cornerA[0], cornerB[1]],
                    [cornerA[0], cornerA[1]]
                ]]
            }
        };
    } else if (drawMode === 'circle') {
        aoiGeoJSON = {
            type: 'Feature',
            properties: { drawMode: 'circle', circleCenter: circleCenter, circleRadius: circleRadius },
            geometry: createCirclePolygon(circleCenter, circleRadius)
        };
    } else if (drawMode === 'polygon') {
        aoiGeoJSON = {
            type: 'Feature',
            properties: { drawMode: 'polygon', polygonPts: polygonPts },
            geometry: {
                type: 'Polygon',
                coordinates: [polygonPts]
            }
        };
    }

    const stats = {
        minLevels: parseInt(document.getElementById('sl-min-levels').value),
        globalCoverage: parseInt(document.getElementById('sl-global-coverage').value),
        globalEfficiency: parseInt(document.getElementById('sl-global-efficiency').value),
        globalIrradiance: parseInt(document.getElementById('sl-global-irradiance').value)
    };

    const projectPayload = {
        name: name,
        aoi_geojson: aoiGeoJSON,
        geojson_data: allGeojsonData,
        solar_stats: stats
    };

    if (supabase && userSession) {
        try {
            const { error } = await supabase
                .from('projects')
                .insert({
                    name: name,
                    aoi_geojson: aoiGeoJSON,
                    geojson_data: allGeojsonData,
                    solar_stats: stats,
                    user_id: userSession.user.id
                });
            if (error) throw error;
            showToast('✅ Berhasil disimpan ke Supabase Cloud!', 'success');
            nameInput.value = '';
            fetchCloudProjects();
        } catch (err) {
            console.error('[Supabase Save Error]', err);
            showToast('⚠️ Gagal simpan ke Cloud. Pastikan tabel projects siap di DDL.', 'error');
            saveLocalFallback(projectPayload);
        }
    } else {
        saveLocalFallback(projectPayload);
    }
    
    if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.innerHTML = 'Simpan';
    }
};

function saveLocalFallback(projectPayload) {
    projectPayload.id = 'local_' + Date.now();
    projectPayload.isCloud = false;
    localProjects.unshift(projectPayload);
    localStorage.setItem('solarcadastre_local_projects', JSON.stringify(localProjects));
    showToast('✅ Berhasil disimpan di Local Browser!', 'success');
    
    const nameInput = document.getElementById('new-project-name');
    if (nameInput) nameInput.value = '';
    
    if (userSession) {
        fetchCloudProjects();
    } else {
        loadLocalProjects();
    }
}

function loadProject(project) {
    setStatus(`Memuat project '${project.name}'...`, 'info');
    
    const stats = project.solar_stats || {};
    document.getElementById('sl-min-levels').value = stats.minLevels || 3;
    document.getElementById('sl-global-coverage').value = stats.globalCoverage || 70;
    document.getElementById('sl-global-efficiency').value = stats.globalEfficiency || 18;
    document.getElementById('sl-global-irradiance').value = stats.globalIrradiance || 1600;
    
    updateParametersUI();

    if (project.aoi_geojson && project.aoi_geojson.geometry) {
        const props = project.aoi_geojson.properties || {};
        const mode = props.drawMode || 'rectangle';
        
        // Switch to the correct mode visually
        setDrawMode(mode);
        
        if (mode === 'rectangle' && project.aoi_geojson.geometry.coordinates) {
            const coords = project.aoi_geojson.geometry.coordinates[0];
            cornerA = coords[0];
            cornerB = coords[2];
            aoiAreaM2 = calculateRectArea(cornerA, cornerB);
        } else if (mode === 'circle') {
            circleCenter = props.circleCenter;
            circleRadius = props.circleRadius;
            aoiAreaM2 = Math.PI * circleRadius * circleRadius;
        } else if (mode === 'polygon') {
            polygonPts = props.polygonPts || project.aoi_geojson.geometry.coordinates[0];
            aoiAreaM2 = polygonAreaM2(polygonPts);
        }
        
        const areaKm2 = aoiAreaM2 / 1000000;
        
        const aoiAreaVal = document.getElementById('aoi-area-val');
        if (aoiAreaVal) aoiAreaVal.textContent = areaKm2.toFixed(3) + ' km²';
        updateAoiEstimations(areaKm2);
        
        const clearBtn = document.getElementById('btn-clear-aoi');
        if (clearBtn) clearBtn.style.display = 'block';
        const runBtn = document.getElementById('btn-run-analysis');
        if (runBtn) {
            runBtn.disabled = false;
            // Force status completed so button enables correctly
            drawState = 'completed';
        }
        
        if (map.getSource('aoi-source')) {
            map.getSource('aoi-source').setData(project.aoi_geojson);
        }
        
        let lons = [], lats = [];
        if (project.aoi_geojson.geometry.coordinates) {
            let pts = project.aoi_geojson.geometry.coordinates[0];
            if (project.aoi_geojson.geometry.type === 'MultiPolygon') {
                pts = project.aoi_geojson.geometry.coordinates[0][0];
            }
            lons = pts.map(c => c[0]);
            lats = pts.map(c => c[1]);
        }
        if (lons.length > 0) {
            fitCameraToAoi(Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats));
        }
    }

    if (project.geojson_data) {
        allGeojsonData = project.geojson_data;
        applyFilters();
        setStatus(`Project '${project.name}' berhasil dimuat!`, 'success');
        const saveProjectBtn = document.getElementById('save-project-btn');
        if (saveProjectBtn) saveProjectBtn.disabled = false;
    }
}

async function deleteProject(id, isCloud) {
    if (!confirm('Apakah Anda yakin ingin menghapus project ini?')) return;
    
    if (isCloud && supabase) {
        setStatus('Menghapus project di cloud...', 'info');
        try {
            const { error } = await supabase
                .from('projects')
                .delete()
                .eq('id', id);
            if (error) throw error;
            showToast('🗑️ Project cloud berhasil dihapus!', 'success');
            fetchCloudProjects();
        } catch (err) {
            showToast('❌ Gagal menghapus project cloud: ' + err.message, 'error');
        }
    } else {
        localProjects = localProjects.filter(p => p.id !== id);
        localStorage.setItem('solarcadastre_local_projects', JSON.stringify(localProjects));
        showToast('🗑️ Project lokal berhasil dihapus!', 'success');
        if (userSession) {
            fetchCloudProjects();
        } else {
            loadLocalProjects();
        }
    }
}

// ============================================================
//  SUPABASE USER AUTHENTICATION
// ============================================================
window.openAuthModal = function() {
    const modal = document.getElementById('auth-modal');
    if (modal) modal.classList.add('open');
};
window.closeAuthModal = function() {
    const modal = document.getElementById('auth-modal');
    if (modal) modal.classList.remove('open');
};
window.switchAuthMode = function() {
    const title = document.getElementById('auth-modal-title');
    const submitBtn = document.getElementById('auth-action-submit');
    const switchText = document.getElementById('auth-switch');
    
    if (authMode === 'login') {
        authMode = 'register';
        if (title) title.textContent = 'Daftar Akun Supabase';
        if (submitBtn) submitBtn.textContent = 'Daftar Akun Baru';
        if (switchText) switchText.innerHTML = 'Sudah punya akun? <span>Masuk Di Sini</span>';
    } else {
        authMode = 'login';
        if (title) title.textContent = 'Masuk ke Supabase';
        if (submitBtn) submitBtn.textContent = 'Masuk';
        if (switchText) switchText.innerHTML = 'Belum punya akun? <span>Daftar Sekarang</span>';
    }
};

window.submitAuth = async function() {
    const emailInput = document.getElementById('auth-email-input');
    const passwordInput = document.getElementById('auth-password-input');
    if (!emailInput || !passwordInput) return;
    
    const email = emailInput.value.trim();
    const password = passwordInput.value;
    
    if (!email || !password) { showToast('⚠️ Harap isi email dan password!', 'error'); return; }
    if (!supabase) { showToast('❌ Supabase Client tidak aktif!', 'error'); return; }
    
    const submitBtn = document.getElementById('auth-action-submit');
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Memproses...';
    }
    
    try {
        if (authMode === 'login') {
            const { data, error } = await supabase.auth.signInWithPassword({ email, password });
            if (error) throw error;
            showToast('🔑 Berhasil masuk!', 'success');
        } else {
            const { data, error } = await supabase.auth.signUp({ email, password });
            if (error) throw error;
            showToast('✉️ Akun berhasil dibuat! Silakan verifikasi email Anda jika diperlukan.', 'success');
        }
        closeAuthModal();
    } catch (err) {
        showToast('❌ Auth error: ' + err.message, 'error');
        console.error('[Auth Error]', err);
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = authMode === 'login' ? 'Masuk' : 'Daftar';
        }
    }
};

async function handleLogout() {
    if (!supabase) return;
    try {
        const { error } = await supabase.auth.signOut();
        if (error) throw error;
        showToast('🚪 Berhasil keluar!', 'info');
    } catch (err) {
        showToast('Gagal keluar', 'error');
    }
}

if (supabase) {
    supabase.auth.onAuthStateChange((event, session) => {
        userSession = session;
        const authBtn = document.getElementById('auth-toggle-btn');
        const statusEl = document.getElementById('auth-email');
        const connStatus = document.getElementById('conn-status');
        
        if (session) {
            if (statusEl) statusEl.innerHTML = `<i class="fa fa-user-check" style="color:var(--green-400)"></i> ${session.user.email}`;
            if (authBtn) {
                authBtn.textContent = 'Keluar';
                authBtn.onclick = handleLogout;
            }
            if (connStatus) connStatus.textContent = 'Cloud Active';
            fetchCloudProjects();
        } else {
            if (statusEl) statusEl.innerHTML = '<i class="fa fa-user-circle"></i> Mode Tamu';
            if (authBtn) {
                authBtn.textContent = 'Masuk';
                authBtn.onclick = openAuthModal;
            }
            if (connStatus) connStatus.textContent = 'Mode Tamu';
            loadLocalProjects();
        }
    });
}

// ============================================================
//  VIEW CONTROLS & BASEMAP TOGGLE
// ============================================================
window.toggleSatelliteLayer = function() {
    if (!map.isStyleLoaded()) return;
    
    isSatelliteOn = !isSatelliteOn;
    if (isSatelliteOn) {
        if (!map.getSource('satellite-source')) {
            map.addSource('satellite-source', {
                type: 'raster',
                tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
                tileSize: 256
            });
        }
        
        if (!map.getLayer('satellite-layer')) {
            map.addLayer({
                id: 'satellite-layer',
                type: 'raster',
                source: 'satellite-source',
                paint: { 'raster-opacity': 0.65 }
            }, 'buildings-3d');
        } else {
            map.setLayoutProperty('satellite-layer', 'visibility', 'visible');
        }
        showToast('🛰️ Satelit Basemap Aktif (Opacity 65%)', 'info');
    } else {
        if (map.getLayer('satellite-layer')) {
            map.setLayoutProperty('satellite-layer', 'visibility', 'none');
        }
        showToast('🗺️ Dark Vector Basemap Aktif', 'info');
    }
};

window.resetView = function() {
    if (cornerA && cornerB) {
        const minLat = Math.min(cornerA[1], cornerB[1]);
        const minLon = Math.min(cornerA[0], cornerB[0]);
        const maxLat = Math.max(cornerA[1], cornerB[1]);
        const maxLon = Math.max(cornerA[0], cornerB[0]);
        fitCameraToAoi(minLon, minLat, maxLon, maxLat);
    } else {
        map.flyTo({ center: [113.9213, -0.7893], zoom: 5, pitch: 0, bearing: 0, duration: 1500 });
    }
};

window.topView = function() {
    map.flyTo({ pitch: 0, bearing: 0, duration: 800 });
};

window.set3DView = function() {
    map.flyTo({ pitch: 65, bearing: -15, duration: 800 });
};

window.hideAnalysisOverlay = function() {
    hideAnalysisOverlay();
};

// ============================================================
//  SQL HELPERS DDL COPY
// ============================================================
window.copySQL = function() {
    const sqlCode = document.getElementById('sql-code');
    if (!sqlCode) return;
    const code = sqlCode.textContent;
    navigator.clipboard.writeText(code)
        .then(() => showToast('📋 SQL berhasil disalin!', 'success'))
        .catch(() => showToast('Gagal menyalin SQL', 'error'));
};

// ============================================================
//  MAP LOAD & INITIAL SETUPS
// ============================================================
map.on('load', () => {
    map.addSource('aoi-source', {
        type: 'geojson',
        data: {
            type: 'FeatureCollection',
            features: []
        }
    });
    
    map.addLayer({
        id: 'aoi-fill',
        type: 'fill',
        source: 'aoi-source',
        paint: {
            'fill-color': [
                'case',
                ['boolean', ['get', 'invalid'], false],
                'rgba(239, 68, 68, 0.15)', // Red if > 5km²
                'rgba(16, 185, 129, 0.15)'  // Green if valid
            ]
        }
    });
    
    map.addLayer({
        id: 'aoi-stroke',
        type: 'line',
        source: 'aoi-source',
        paint: {
            'line-color': [
                'case',
                ['boolean', ['get', 'invalid'], false],
                '#f87171',
                '#34d399'
            ],
            'line-width': 2,
            'line-dasharray': [4, 3]
        }
    });

    loadLocalProjects();

    setTimeout(() => {
        const loadingOverlay = document.getElementById('loading-overlay');
        if (loadingOverlay) loadingOverlay.classList.add('hidden');
    }, 500);
});

map.on('error', e => console.warn('[MapLibre Log]', e?.error?.message ?? e));

map.on('style.load', () => {
    try {
        if (map.getFog) {
            map.setFog({
                color: '#020617',
                'high-color': '#0f172a',
                'horizon-blend': 0.08,
                'space-color': '#020617',
                'star-intensity': 0.2
            });
        }
    } catch(_) {}
});

} catch(GLOBAL_ERR) {
    console.error('[FATAL] Script crash:', GLOBAL_ERR);
    if (window._guaranteedCloseOverlay) window._guaranteedCloseOverlay();
    var sb = document.getElementById('status-bar');
    if (sb) sb.innerHTML = '<span style="color:#f87171">⚠️ Fatal Error: ' + GLOBAL_ERR.message + '</span>';
}
