/* global acquireVsCodeApi */
const vscode = acquireVsCodeApi();

const LANGUAGES = [
    { id: 'python', label: 'Python (语言代码 6)' },
    { id: 'cpp', label: 'C++ (语言代码 1)' },
    { id: 'java', label: 'Java (语言代码 3)' },
];
const LANGUAGE_ID_SET = new Set(LANGUAGES.map((entry) => entry.id));

const METADATA_LABEL_ALIASES = {
    '来源/分类': '来源/分类',
    'source/category': '来源/分类',
    'source': '来源/分类',
    'memory limit': '内存限制',
    'time limit': '时间限制',
    'judge style': '评测方式',
    'creator': '命题人',
    'submit': '提交数',
    'solved': '通过数',
};
const state = {
    loggedIn: false,
    problemset: [],
    currentProblemId: null,
    pendingRestore: false,
    problemsetRequest: null,
    rememberPassword: true,
    hasSavedPassword: false,
    savedUserId: '',
    samples: {
        input: '',
        output: '',
    },
    preferredLanguage: LANGUAGES[0].id,
    submission: {
        initial: null,
        final: null,
        loading: false,
        error: null,
    },
};

let selectedProblemRow = null;

const loginPanel = document.getElementById('login-panel');
const loginSummary = document.getElementById('login-summary');
const loginForm = document.getElementById('login-form');
const loginStatus = document.getElementById('login-status');
const rememberCheckbox = loginForm.querySelector('input[name="remember"]');
const useSavedPasswordButton = document.getElementById('use-saved-password');
const problemsetForm = document.getElementById('problemset-form');
const problemsetTable = document.getElementById('problemset-table');
const problemsetBody = problemsetTable.querySelector('tbody');
const problemOutput = document.getElementById('problem-output');
const problemActions = document.getElementById('problem-actions');
const fileStatus = document.getElementById('file-status');
const detailFileForm = document.getElementById('detail-file-form');
const detailSubmitForm = document.getElementById('detail-submit-form');
const languageSelect = document.getElementById('language-select');
const submitFileInput = detailSubmitForm.querySelector('input[name="filePath"]');
const submissionOutput = document.getElementById('submission-output');
const statusForm = document.getElementById('status-form');
const statusTable = document.getElementById('status-table');
const statusBody = statusTable.querySelector('tbody');
const sampleTestButton = document.getElementById('sample-test-button');
const sampleTestStatus = document.getElementById('sample-test-status');
const sampleTestOutput = document.getElementById('sample-test-output');
const problemToolbar = document.getElementById('problem-toolbar');
const toolbarOpenButton = document.getElementById('toolbar-open-file');
const problemNavigation = document.getElementById('problem-navigation');
const navPrevButton = document.getElementById('nav-prev-button');
const navNextButton = document.getElementById('nav-next-button');

if (languageSelect) {
    languageSelect.addEventListener('change', () => {
        setPreferredLanguage(String(languageSelect.value), { notifyExtension: true });
    });
}

if (toolbarOpenButton && detailFileForm) {
    toolbarOpenButton.addEventListener('click', (event) => {
        event.preventDefault();
        if (typeof detailFileForm.requestSubmit === 'function') {
            detailFileForm.requestSubmit();
        } else {
            const submitEvent = new Event('submit', { bubbles: true, cancelable: true });
            detailFileForm.dispatchEvent(submitEvent);
        }
    });
}

if (navPrevButton) {
    navPrevButton.addEventListener('click', (event) => {
        event.preventDefault();
        if (navPrevButton.disabled) {
            return;
        }
        navigateToAdjacentProblem(-1);
    });
}

if (navNextButton) {
    navNextButton.addEventListener('click', (event) => {
        event.preventDefault();
        if (navNextButton.disabled) {
            return;
        }
        navigateToAdjacentProblem(1);
    });
}

function renderStatusChip(accepted) {
    if (accepted === true) {
        return '<span class="status-chip success">已通过</span>';
    }
    if (accepted === false) {
        return '<span class="status-chip danger">未通过</span>';
    }
    return '<span class="status-chip neutral">未评测</span>';
}

function updateProblemCompletion(problemId, accepted) {
    const numericId = Number(problemId);
    if (!Number.isFinite(numericId)) {
        return;
    }
    const itemIndex = state.problemset.findIndex((entry) => Number(entry.problem_id) === numericId);
    if (itemIndex === -1) {
        return;
    }
    const item = state.problemset[itemIndex];
    item.is_accepted = accepted ? true : item.is_accepted;
    const row = problemsetBody.querySelector(`tr[data-problem-id="${item.problem_id}"]`);
    if (!row) {
        return;
    }
    row.classList.remove('accepted', 'pending');
    if (item.is_accepted === true) {
        row.classList.add('accepted');
    } else if (item.is_accepted === false) {
        row.classList.add('pending');
    }
    const meta = row.querySelector('.meta');
    if (meta) {
        const pageLabel = item.page ?? '-';
        meta.innerHTML = `第 ${pageLabel} 页 · ${renderStatusChip(item.is_accepted === true ? true : item.is_accepted === false ? false : undefined)}`;
    }
    const chip = row.querySelector('.status-chip');
    if (chip) {
        chip.classList.remove('success', 'danger', 'neutral');
        if (item.is_accepted === true) {
            chip.classList.add('success');
            chip.textContent = '已通过';
        } else if (item.is_accepted === false) {
            chip.classList.add('danger');
            chip.textContent = '未通过';
        } else {
            chip.classList.add('neutral');
            chip.textContent = '未评测';
        }
    }
    highlightProblemRow(numericId);
}

function canonicalMetadataLabel(label) {
    const key = String(label ?? '').toLowerCase().trim();
    if (!key) {
        return '';
    }
    return METADATA_LABEL_ALIASES[key] ?? label.trim();
}

function normalizeValueList(raw) {
    if (raw === undefined || raw === null) {
        return [];
    }
    const values = Array.isArray(raw) ? raw : String(raw).split(/\r?\n+/u);
    const cleaned = values
        .map((item) => String(item).trim())
        .filter((item) => Boolean(item));
    const unique = Array.from(new Set(cleaned));
    return unique;
}

function collectMetadataEntries(problem) {
    const entries = [];
    const seenSignatures = new Set();
    const maybeAdd = (label, rawValue) => {
        const canonicalLabel = canonicalMetadataLabel(label);
        if (!canonicalLabel) {
            return;
        }
        const list = normalizeValueList(rawValue);
        if (list.length === 0) {
            return;
        }
        const signature = `${canonicalLabel}::${list.map((item) => item.toLowerCase()).join('|')}`;
        if (seenSignatures.has(signature)) {
            return;
        }
        seenSignatures.add(signature);
        entries.push({
            label: canonicalLabel,
            value: list.join(' / '),
        });
    };

    if (problem.source) {
        maybeAdd('来源/分类', problem.source);
    }

    for (const [label, value] of Object.entries(problem.metadata ?? {})) {
        maybeAdd(label, value);
    }

    return entries;
}

function normalizeProblemId(value) {
    if (value === null || value === undefined || value === '') {
        return null;
    }
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
}

function findProblemIndexById(problemId) {
    const numeric = normalizeProblemId(problemId);
    if (numeric === null) {
        return -1;
    }
    return state.problemset.findIndex((entry) => normalizeProblemId(entry.problem_id) === numeric);
}

function getAdjacentProblemId(offset) {
    if (!Number.isInteger(offset) || offset === 0) {
        return null;
    }
    const currentId = normalizeProblemId(state.currentProblemId);
    if (currentId === null) {
        return null;
    }
    const index = findProblemIndexById(currentId);
    if (index === -1) {
        return null;
    }
    const neighbor = state.problemset[index + offset];
    if (!neighbor) {
        return null;
    }
    return normalizeProblemId(neighbor.problem_id);
}

function syncProblemControls() {
    const hasSelection = typeof state.currentProblemId === 'number' && Number.isFinite(state.currentProblemId);
    if (problemToolbar) {
        problemToolbar.classList.toggle('hidden', !hasSelection);
    }
    if (toolbarOpenButton) {
        toolbarOpenButton.disabled = !hasSelection;
    }
    let prevId = null;
    let nextId = null;
    if (hasSelection) {
        prevId = getAdjacentProblemId(-1);
        nextId = getAdjacentProblemId(1);
    }
    if (problemNavigation) {
        problemNavigation.classList.toggle('hidden', !hasSelection);
    }
    if (navPrevButton) {
        const hasPrev = typeof prevId === 'number' && Number.isFinite(prevId);
        navPrevButton.disabled = !hasPrev;
        navPrevButton.dataset.targetId = hasPrev ? String(prevId) : '';
        navPrevButton.title = hasPrev ? `跳转到题目 ${prevId}` : '没有上一题';
    }
    if (navNextButton) {
        const hasNext = typeof nextId === 'number' && Number.isFinite(nextId);
        navNextButton.disabled = !hasNext;
        navNextButton.dataset.targetId = hasNext ? String(nextId) : '';
        navNextButton.title = hasNext ? `跳转到题目 ${nextId}` : '没有下一题';
    }
}

function updateSavedPasswordButton() {
    if (!useSavedPasswordButton) {
        return;
    }
    const hasSaved = Boolean(state.hasSavedPassword && state.savedUserId);
    useSavedPasswordButton.classList.toggle('hidden', !hasSaved);
    if (!hasSaved) {
        useSavedPasswordButton.disabled = true;
        useSavedPasswordButton.title = '暂无已保存的密码';
        return;
    }
    useSavedPasswordButton.disabled = false;
    useSavedPasswordButton.textContent = state.loggedIn ? '重新使用已保存的密码登录' : '使用已保存的密码登录';
    useSavedPasswordButton.title = `使用已保存的密码登录账号 ${state.savedUserId}`;
    const usernameField = loginForm.querySelector('input[name="username"]');
    if (usernameField && !usernameField.value) {
        usernameField.value = state.savedUserId;
    }
}

function updateLoginSummary(text) {
    if (!loginSummary) {
        return;
    }
    loginSummary.textContent = text;
}

function collapseLoginPanel(userId, restored = false) {
    if (!loginPanel) {
        return;
    }
    const prefix = restored ? '已恢复登录' : '已登录';
    const safeUserId = userId ? String(userId) : '未知用户';
    updateLoginSummary(`${prefix}：${safeUserId}（点击展开以重新登录）`);
    loginPanel.open = false;
}

function expandLoginPanel() {
    if (!loginPanel) {
        return;
    }
    updateLoginSummary('登录账号（点击展开）');
    if (!loginPanel.open) {
        loginPanel.open = true;
    }
}

function setPreferredLanguage(value, options = {}) {
    const fallback = LANGUAGES[0]?.id ?? 'python';
    const normalized = LANGUAGE_ID_SET.has(value) ? value : fallback;
    const changed = normalized !== state.preferredLanguage;
    state.preferredLanguage = normalized;
    if (languageSelect && languageSelect.value !== normalized) {
        languageSelect.value = normalized;
    }
    if (options.notifyExtension && changed) {
        vscode.postMessage({
            type: 'setPreferredLanguage',
            payload: { language: normalized },
        });
    }
}

function populateLanguages() {
    for (const option of LANGUAGES) {
        const one = document.createElement('option');
        one.value = option.id;
        one.textContent = option.label;
        languageSelect.appendChild(one);
    }
    setPreferredLanguage(state.preferredLanguage);
}

function setStatus(target, message, isError = false) {
    target.textContent = message;
    if (isError) {
        target.classList.add('error');
    } else {
        target.classList.remove('error');
    }
}

function resetSampleTestUI() {
    if (sampleTestStatus) {
        setStatus(sampleTestStatus, '');
    }
    if (sampleTestOutput) {
        sampleTestOutput.textContent = '';
        sampleTestOutput.classList.add('hidden');
    }
}

function updateSampleTestAvailability() {
    const hasSample = Boolean(state.samples.input && state.samples.input.trim());
    if (sampleTestButton) {
        sampleTestButton.disabled = !hasSample;
    }
    if (problemOutput) {
        problemOutput.querySelectorAll('.sample-run-btn').forEach((btn) => {
            btn.disabled = !hasSample;
        });
    }
}

function triggerSampleTest() {
    if (!sampleTestStatus || !sampleTestOutput) {
        return;
    }
    if (!state.currentProblemId) {
        setStatus(sampleTestStatus, '请先选择题目后再运行样例', true);
        return;
    }
    const hasSample = Boolean(state.samples.input && state.samples.input.trim());
    if (!hasSample) {
        setStatus(sampleTestStatus, '当前题目没有提供样例输入', true);
        return;
    }
    const filePath = submitFileInput.value.trim();
    if (!filePath) {
        setStatus(sampleTestStatus, '请先填写代码文件路径', true);
        return;
    }
    setStatus(sampleTestStatus, '使用样例执行中…');
    if (sampleTestOutput) {
        sampleTestOutput.textContent = '';
        sampleTestOutput.classList.add('hidden');
    }
    vscode.postMessage({
        type: 'runSampleTest',
        payload: {
            problemId: state.currentProblemId,
            language: state.preferredLanguage,
            filePath,
            sampleInput: state.samples.input,
            expectedOutput: state.samples.output || null,
        },
    });
}

function renderSampleTestResult(payload) {
    if (!sampleTestStatus || !sampleTestOutput) {
        return;
    }
    if (!payload.ok) {
        setStatus(sampleTestStatus, payload.error ?? '执行失败', true);
        sampleTestOutput.textContent = '';
        sampleTestOutput.classList.add('hidden');
        return;
    }
    const exitLabel = payload.exitCode === undefined || payload.exitCode === null ? '未知' : String(payload.exitCode);
    const matched = payload.matched;
    if (matched === false) {
        setStatus(sampleTestStatus, `执行完成：输出与样例不一致（退出码 ${exitLabel}）`, true);
    } else if (matched === true) {
        setStatus(sampleTestStatus, `执行完成：输出与样例一致（退出码 ${exitLabel}）`);
    } else {
        setStatus(sampleTestStatus, `执行完成（退出码 ${exitLabel}）`);
    }
    const parts = [];
    const stdout = payload.stdout ?? '';
    const stderr = payload.stderr ?? '';
    const expected = payload.expectedOutput ?? '';
    parts.push(`【标准输出】\n${stdout || '(空)'}`);
    if (stderr) {
        parts.push(`【标准错误】\n${stderr}`);
    }
    if (payload.expectedOutput !== null) {
        parts.push(`【样例输出】\n${expected || '(空)'}`);
    }
    sampleTestOutput.textContent = parts.join('\n\n');
    sampleTestOutput.classList.remove('hidden');
}

function restoreProblemsetForm(request) {
    if (!request) {
        return;
    }
    const startInput = problemsetForm.querySelector('input[name="startPage"]');
    const maxInput = problemsetForm.querySelector('input[name="maxPages"]');
    if (startInput) {
        const rawStart = Number(request.startPage);
        const normalizedStart = Number.isFinite(rawStart) && rawStart > 0 ? rawStart : 1;
        startInput.value = String(normalizedStart);
    }
    if (maxInput) {
        const rawMax = Number(request.maxPages);
        if (!Number.isFinite(rawMax) || rawMax <= 1) {
            maxInput.value = '';
        } else {
            const normalizedMax = Math.max(1, rawMax);
            maxInput.value = String(normalizedMax);
        }
    }
}

function flattenProblemset(problemset) {
    const rows = [];
    for (const [page, problems] of Object.entries(problemset)) {
        for (const problem of problems) {
            rows.push({ ...problem, page });
        }
    }
    return rows.sort((a, b) => String(a.problem_id).localeCompare(String(b.problem_id), 'zh-Hans-CN', { numeric: true }));
}

function highlightProblemRow(problemId) {
    const selector = `tr[data-problem-id="${problemId}"]`;
    const row = problemsetBody.querySelector(selector);
    if (!row) {
        return false;
    }
    if (selectedProblemRow && selectedProblemRow !== row) {
        selectedProblemRow.classList.remove('active');
    }
    selectedProblemRow = row;
    row.classList.add('active');
    problemActions.classList.remove('hidden');
    syncProblemControls();
    return true;
}

function clearCurrentProblem({ notifyExtension = true } = {}) {
    if (selectedProblemRow) {
        selectedProblemRow.classList.remove('active');
        selectedProblemRow = null;
    }
    if (notifyExtension && state.currentProblemId !== null) {
        vscode.postMessage({ type: 'selectProblem', payload: { problemId: null } });
    }
    state.currentProblemId = null;
    state.pendingRestore = false;
    state.samples = { input: '', output: '' };
    problemActions.classList.add('hidden');
    problemOutput.innerHTML = '<div class="placeholder">请选择题目以查看详情</div>';
    setStatus(fileStatus, '');
    resetSubmissionState();
    resetSampleTestUI();
    updateSampleTestAvailability();
    syncProblemControls();
}

function selectProblemById(problemId) {
    const normalizedId = normalizeProblemId(problemId);
    if (normalizedId === null) {
        return false;
    }
    const row = problemsetBody.querySelector(`tr[data-problem-id="${normalizedId}"]`);
    if (!row) {
        return false;
    }
    state.pendingRestore = false;
    state.currentProblemId = normalizedId;
    resetSubmissionState();
    if (!highlightProblemRow(normalizedId)) {
        return false;
    }
    setStatus(fileStatus, '');
    problemOutput.innerHTML = '<div class="placeholder">题目详情加载中…</div>';
    vscode.postMessage({
        type: 'selectProblem',
        payload: { problemId: normalizedId },
    });
    vscode.postMessage({
        type: 'fetchProblem',
        payload: { problemId: normalizedId },
    });
    row.scrollIntoView({ block: 'nearest' });
    return true;
}

function navigateToAdjacentProblem(offset) {
    const targetId = getAdjacentProblemId(offset);
    if (targetId === null) {
        return;
    }
    selectProblemById(targetId);
}

function normalizeContent(value) {
    return String(value ?? '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

const SUBMISSION_INITIAL_FIELDS = [
    { key: 'solution_id', label: '提交编号' },
    { key: 'result_text', label: '当前状态' },
    { key: 'user', label: '用户名' },
    { key: 'nickname', label: '昵称' },
    { key: 'problem_id', label: '题目编号' },
    { key: 'language', label: '语言' },
    { key: 'code_length', label: '代码长度' },
    { key: 'submitted_at', label: '提交时间' },
];

const SUBMISSION_FINAL_FIELDS = [
    { key: 'solution_id', label: '提交编号' },
    { key: 'result_text', label: '最终结果' },
    { key: 'result_code', label: '结果代码' },
    { key: 'memory', label: '内存' },
    { key: 'time', label: '耗时' },
    { key: 'ac_rate', label: '通过率' },
];

const SUBMISSION_COMBINED_FIELDS = [
    { key: 'solution_id', label: '提交编号' },
    { key: 'result_text', label: '结果状态' },
    { key: 'result_code', label: '结果代码' },
    { key: 'user', label: '用户名' },
    { key: 'nickname', label: '昵称' },
    { key: 'problem_id', label: '题目编号' },
    { key: 'language', label: '语言' },
    { key: 'code_length', label: '代码长度' },
    { key: 'submitted_at', label: '提交时间' },
    { key: 'memory', label: '内存' },
    { key: 'time', label: '耗时' },
    { key: 'ac_rate', label: '通过率' },
];

function resetSubmissionState() {
    state.submission = {
        initial: null,
        final: null,
        loading: false,
        error: null,
    };
    renderSubmissionPlaceholder();
}

function renderSubmissionPlaceholder() {
    submissionOutput.innerHTML = '<div class="placeholder">执行提交后将在此处展示结果</div>';
}

function renderSubmissionLoading() {
    submissionOutput.innerHTML = '<div class="placeholder">提交中，请稍候…</div>';
}

function renderSubmissionError(message) {
    submissionOutput.innerHTML = `<div class="placeholder error">${escapeHtml(message)}</div>`;
}

function formatKeyValueList(data, fields) {
    if (!data) {
        return '';
    }
    const items = fields
        .map((field) => {
            const value = data[field.key];
            if (value === undefined || value === null || value === '') {
                return '';
            }
            return `
				<div class="kv-item">
					<span class="kv-label">${escapeHtml(field.label)}</span>
					<span class="kv-value">${escapeHtml(String(value))}</span>
				</div>
			`;
        })
        .filter(Boolean)
        .join('');
    return items;
}

function getResultPill(resultText, resultCode) {
    const code = Number(resultCode);
    let tone = 'neutral';
    if (Number.isFinite(code)) {
        if (code === 4) {
            tone = 'success';
        } else if (code > 4) {
            tone = 'danger';
        }
    }
    const text = resultText ? escapeHtml(String(resultText)) : '未知状态';
    return `<span class="result-pill ${tone}">${text}</span>`;
}

function renderSubmissionState() {
    const { initial, final, loading, error } = state.submission;
    if (error) {
        renderSubmissionError(error);
        return;
    }
    if (!initial && !final && !loading) {
        renderSubmissionPlaceholder();
        return;
    }
    if (loading && !initial) {
        renderSubmissionLoading();
        return;
    }
    const sections = [];
    if (final) {
        const combined = { ...(initial ?? {}), ...final };
        const list = formatKeyValueList(combined, SUBMISSION_COMBINED_FIELDS);
        const badge = getResultPill(final.result_text ?? combined.result_text ?? '未知', final.result_code ?? combined.result_code);
        sections.push(`
			<section class="submission-section">
				<header>
					<h3>提交结果</h3>
					${badge}
				</header>
				<div class="kv-list">${list}</div>
			</section>
		`);
    } else if (initial) {
        const list = formatKeyValueList(initial, SUBMISSION_INITIAL_FIELDS);
        const badge = getResultPill(initial.result_text ?? '排队中', initial.result_code);
        sections.push(`
			<section class="submission-section">
				<header>
					<h3>提交响应</h3>
					${badge}
				</header>
				<div class="kv-list">${list}</div>
			</section>
		`);
    }
    if (!final && loading) {
        sections.push(`
			<section class="submission-section">
				<header>
					<h3>最终判题</h3>
					<span class="result-pill neutral">等待评测结果…</span>
				</header>
				<div class="kv-list">
					<div class="kv-item">
						<span class="kv-label">提示</span>
						<span class="kv-value">系统正在获取最终结果</span>
					</div>
				</div>
			</section>
		`);
    }
    if (sections.length === 0) {
        renderSubmissionPlaceholder();
        return;
    }
    submissionOutput.innerHTML = `<div class="submission-panels">${sections.join('')}</div>`;
}

function renderProblemset(data) {
    state.problemset = flattenProblemset(data);
    problemsetBody.innerHTML = '';
    const previousId = state.currentProblemId;
    let matchedRow = null;
    if (state.problemset.length === 0) {
        clearCurrentProblem({ notifyExtension: previousId !== null });
        const row = document.createElement('tr');
        row.innerHTML = '<td colspan="4" class="placeholder">未获取到题目数据</td>';
        problemsetBody.appendChild(row);
        return;
    }
    for (const problem of state.problemset) {
        const row = document.createElement('tr');
        row.dataset.problemId = String(problem.problem_id);
        if (problem.is_accepted === true) {
            row.classList.add('accepted');
        } else if (problem.is_accepted === false) {
            row.classList.add('pending');
        }
        const solved = problem.solved ?? '-';
        const submitted = problem.submitted ?? '-';
        const acceptanceValue = problem.acceptance ?? problem.accept;
        const numericAcceptance = Number.parseFloat(acceptanceValue);
        const acceptance = Number.isFinite(numericAcceptance)
            ? `${numericAcceptance.toFixed(2)}%`
            : '-';
        const problemIdNumber = Number(problem.problem_id);
        row.innerHTML = `
				<td>${problem.problem_id}</td>
				<td>
					<div class="title">${problem.title}</div>
					<div class="meta">第 ${problem.page} 页 · ${renderStatusChip(problem.is_accepted)}</div>
				</td>
				<td>${solved} / ${submitted}</td>
				<td>${acceptance}</td>
			`;
        problemsetBody.appendChild(row);
        if (Number.isFinite(problemIdNumber) && problemIdNumber === previousId) {
            matchedRow = row;
        }
    }

    if (matchedRow) {
        state.currentProblemId = previousId;
        highlightProblemRow(previousId);
        if (state.pendingRestore && state.currentProblemId !== null) {
            const restoreId = state.currentProblemId;
            state.pendingRestore = false;
            problemOutput.innerHTML = '<div class="placeholder">题目详情加载中…</div>';
            vscode.postMessage({
                type: 'fetchProblem',
                payload: { problemId: restoreId },
            });
        }
    } else {
        const shouldNotify = previousId !== null;
        clearCurrentProblem({ notifyExtension: shouldNotify });
    }
    syncProblemControls();
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

const SANITIZE_ALLOWED_TAGS = new Set([
    'a',
    'b',
    'blockquote',
    'br',
    'code',
    'em',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'hr',
    'i',
    'img',
    'li',
    'ol',
    'p',
    'pre',
    'span',
    'strong',
    'sub',
    'sup',
    'table',
    'tbody',
    'td',
    'tfoot',
    'th',
    'thead',
    'ul',
    'tr',
    'div',
]);

const SANITIZE_GLOBAL_ATTRIBUTES = new Set(['class']);

const SANITIZE_TAG_ATTRIBUTES = {
    a: ['href', 'title', 'target', 'rel'],
    img: ['src', 'alt', 'title', 'width', 'height'],
    table: ['border', 'cellpadding', 'cellspacing'],
    td: ['colspan', 'rowspan'],
    th: ['colspan', 'rowspan'],
};

const SANITIZE_PRESERVE_WHITESPACE_TAGS = new Set(['pre', 'code']);
const SANITIZE_INLINE_TRIM_TAGS = ['sup', 'sub'];

function isSafeUrl(value, { allowDataImage } = { allowDataImage: false }) {
    if (!value) {
        return false;
    }
    const trimmed = String(value).trim();
    if (!trimmed) {
        return false;
    }
    const lower = trimmed.toLowerCase();
    if (lower.startsWith('javascript:') || lower.startsWith('vbscript:')) {
        return false;
    }
    if (lower.startsWith('data:')) {
        return allowDataImage && /^data:image\//iu.test(lower);
    }
    return /^(https?:|vscode-resource:|vscode-file:|\/)/iu.test(trimmed);
}

function unwrapElement(element) {
    const parent = element.parentNode;
    if (!parent) {
        element.remove();
        return;
    }
    for (const child of Array.from(element.childNodes)) {
        parent.insertBefore(child, element);
    }
    parent.removeChild(element);
}

function collapseWhitespace(node, preserve = false) {
    const shouldPreserve = preserve || SANITIZE_PRESERVE_WHITESPACE_TAGS.has(node.nodeName?.toLowerCase?.() ?? '');
    for (const child of Array.from(node.childNodes)) {
        if (child.nodeType === Node.TEXT_NODE && !shouldPreserve) {
            const collapsed = child.textContent?.replace(/\s+/gu, ' ') ?? '';
            child.textContent = collapsed;
        } else if (child.nodeType === Node.ELEMENT_NODE) {
            collapseWhitespace(child, shouldPreserve);
        }
    }
}

function sanitizeHtml(input) {
    if (!input) {
        return '';
    }
    const parser = new DOMParser();
    const documentWrapper = parser.parseFromString(`<div>${input}</div>`, 'text/html');
    const container = documentWrapper.body.firstElementChild;
    if (!container) {
        return '';
    }

    const sanitizeNode = (node) => {
        for (const child of Array.from(node.childNodes)) {
            if (child.nodeType === Node.ELEMENT_NODE) {
                const tag = child.tagName.toLowerCase();
                if (!SANITIZE_ALLOWED_TAGS.has(tag)) {
                    unwrapElement(child);
                    sanitizeNode(node);
                    return;
                }
                const allowedAttributes = new Set([
                    ...SANITIZE_GLOBAL_ATTRIBUTES,
                    ...(SANITIZE_TAG_ATTRIBUTES[tag] ?? []),
                ]);
                for (const attribute of Array.from(child.attributes)) {
                    const name = attribute.name.toLowerCase();
                    if (!allowedAttributes.has(name)) {
                        child.removeAttribute(attribute.name);
                        continue;
                    }
                    const value = attribute.value;
                    if (name === 'href' && !isSafeUrl(value, { allowDataImage: false })) {
                        child.removeAttribute(attribute.name);
                        continue;
                    }
                    if (name === 'src' && !isSafeUrl(value, { allowDataImage: tag === 'img' })) {
                        child.removeAttribute(attribute.name);
                        continue;
                    }
                    if (name === 'target') {
                        child.setAttribute('target', '_blank');
                        const rel = child.getAttribute('rel') ?? '';
                        const tokens = new Set(rel.split(/\s+/u).filter(Boolean));
                        tokens.add('noopener');
                        tokens.add('noreferrer');
                        child.setAttribute('rel', Array.from(tokens).join(' '));
                    }
                }
                sanitizeNode(child);
            } else if (child.nodeType === Node.TEXT_NODE) {
                continue;
            } else {
                child.remove();
            }
        }
    };

    sanitizeNode(container);
    collapseWhitespace(container);
    let sanitized = container.innerHTML.trim();
    for (const tag of SANITIZE_INLINE_TRIM_TAGS) {
        sanitized = sanitized.replace(new RegExp(`\\s*(<\\/?${tag}\\b[^>]*>)\\s*`, 'giu'), '$1');
    }
    return sanitized;
}

function formatParagraph(value) {
    if (!value) {
        return '';
    }
    const raw = String(value);
    if (/<\/?[a-z][\s\S]*>/iu.test(raw)) {
        return sanitizeHtml(raw);
    }
    const escaped = escapeHtml(raw).replace(/\n/g, '<br />');
    return `<p>${escaped}</p>`;
}

function renderProblemDetail(problem) {
    const numericId = Number(problem.problem_id);
    if (Number.isFinite(numericId) && !Number.isNaN(numericId)) {
        state.currentProblemId = numericId;
    }
    state.samples = {
        input: problem.sample_input ? String(problem.sample_input) : '',
        output: problem.sample_output ? String(problem.sample_output) : '',
    };
    resetSampleTestUI();
    updateSampleTestAvailability();
    if (problem.is_private) {
        const problemIdLabel = problem.problem_id ?? '-';
        const displayTitle = problem.raw_title || problem.title || `题目 ${problemIdLabel}`;
        const problemUrl = problem.url
            ? `<a href="${escapeHtml(problem.url)}" target="_blank">查看原题</a>`
            : '<span>无原题链接</span>';
        const contests = Array.isArray(problem.private_contests) ? problem.private_contests : [];
        const friendlyMessage = problem.private_message
            ? escapeHtml(problem.private_message)
            : '题目正用于私有比赛，当前无法查看题面内容。';
        const contestList = contests.length
            ? `
                <p>目前包含在以下私有比赛中：</p>
                <ul class="private-contest-list">
                    ${contests
                        .map((contest) => {
                            const name = escapeHtml(contest.name ?? '未知比赛');
                            const url = contest.url ? `<a href="${escapeHtml(contest.url)}" target="_blank">${name}</a>` : name;
                            return `<li>${url}</li>`;
                        })
                        .join('')}
                </ul>
            `
            : '<p>该题目正用于私有比赛，因此暂不可浏览题面。</p>';
        const rawNotice = problem.private_notice ? sanitizeHtml(problem.private_notice) : '';
        const headerHtml = `
            <div class="problem-header">
                <h3>${escapeHtml(displayTitle)}</h3>
                <div class="problem-meta">
                    <span>编号：${escapeHtml(String(problemIdLabel))}</span>
                    <span>来源：${problemUrl}</span>
                </div>
            </div>
        `;
        const detailsHtml = rawNotice
            ? `
                <details class="notice-raw">
                    <summary>查看平台原始提示</summary>
                    <div>${rawNotice}</div>
                </details>
            `
            : '';
        problemOutput.innerHTML = `${headerHtml}<div class="problem-private"><h3>无法查看题目详情</h3><p>${friendlyMessage}</p>${contestList}${detailsHtml}</div>`;
        problemActions.classList.add('hidden');
        setStatus(fileStatus, '');
        renderSubmissionState();
        state.pendingRestore = false;
        syncProblemControls();
        return;
    }
    const sections = [];
    const seenContent = new Set();
    const pushSection = (title, rawValue, formatter = formatParagraph) => {
        if (rawValue === undefined || rawValue === null) {
            return;
        }
        const signature = normalizeContent(rawValue);
        if (!signature || seenContent.has(signature)) {
            return;
        }
        seenContent.add(signature);
        const formatted = formatter(String(rawValue));
        if (!formatted || !formatted.trim()) {
            return;
        }
        sections.push({ title, content: formatted });
    };

    pushSection('题目描述', problem.description);
    pushSection('输入说明', problem.input);
    pushSection('输出说明', problem.output);
    pushSection(
        '样例输入',
        problem.sample_input,
        (value) => `
				<div class="sample-block">
					<div class="sample-actions">
						<button type="button" class="sample-run-btn">使用样例快速测试</button>
					</div>
					<pre>${escapeHtml(value)}</pre>
				</div>
			`,
    );
    pushSection('样例输出', problem.sample_output, (value) => `<pre>${escapeHtml(value)}</pre>`);
    pushSection('提示', problem.hint);

    const metadataEntries = collectMetadataEntries(problem);
    const metadataLabels = new Set(metadataEntries.map((entry) => normalizeContent(entry.label)));
    const metadataValues = new Set(metadataEntries.map((entry) => normalizeContent(entry.value)));

    if (problem.raw_sections) {
        const skipTitles = new Set(['description', 'input', 'output', 'sample input', 'sample output', 'hint', 'source/category']);
        for (const [title, value] of Object.entries(problem.raw_sections)) {
            const normalizedTitle = normalizeContent(title);
            if (skipTitles.has(normalizedTitle)) {
                continue;
            }
            if (metadataLabels.has(normalizedTitle) || metadataValues.has(normalizedTitle)) {
                continue;
            }
            pushSection(title, value, (content) => formatParagraph(content));
        }
    }

    const tags = Array.isArray(problem.tags) ? problem.tags : [];
    const problemTitle = problem.raw_title || `${problem.problem_id ?? ''} ${problem.title ?? ''}`;
    const problemUrl = problem.url ? `<a href="${escapeHtml(problem.url)}" target="_blank">查看原题</a>` : '<span>无原题链接</span>';

    const headerHtml = `
			<div class="problem-header">
				<h3>${escapeHtml(problemTitle)}</h3>
				<div class="problem-meta">
					<span>编号：${escapeHtml(String(problem.problem_id))}</span>
					<span>来源：${problemUrl}</span>
				</div>
			</div>
		`;

    const metaHtml = metadataEntries.length
        ? `<div class="meta-grid">${metadataEntries
            .map(({ label, value }) => `
						<div class="meta-item">
							<span class="meta-label">${escapeHtml(label)}</span>
							<span class="meta-value">${escapeHtml(value)}</span>
						</div>`)
            .join('')}</div>`
        : '';

    const sectionsHtml = sections.length
        ? `<div class="problem-sections">${sections
            .map((section) => `
						<section>
							<h3>${escapeHtml(section.title)}</h3>
							<div>${section.content}</div>
						</section>
					`)
            .join('')}</div>`
        : '';

    const tagsHtml = tags.length
        ? `<div class="tag-list">${tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join('')}</div>`
        : '';

    problemOutput.innerHTML = `${headerHtml}${metaHtml}${sectionsHtml}${tagsHtml}`;
    updateSampleTestAvailability();
    if (state.currentProblemId !== null) {
        highlightProblemRow(state.currentProblemId);
    }
    problemActions.classList.toggle('hidden', state.currentProblemId === null);
    setStatus(fileStatus, '');
    renderSubmissionState();
    state.pendingRestore = false;
    syncProblemControls();
}

function renderStatusTable(entries) {
    statusBody.innerHTML = '';
    if (!Array.isArray(entries) || entries.length === 0) {
        const row = document.createElement('tr');
        row.innerHTML = '<td colspan="7" class="placeholder">未获取到提交记录</td>';
        statusBody.appendChild(row);
        return;
    }
    for (const entry of entries) {
        const row = document.createElement('tr');
        row.innerHTML = `
				<td>${entry.solution_id ?? '-'}</td>
				<td>${escapeHtml(entry.problem_id ?? '-')}</td>
				<td>${escapeHtml(entry.result_text ?? '-')}</td>
				<td>${escapeHtml(entry.time ?? '-')}</td>
				<td>${escapeHtml(entry.memory ?? '-')}</td>
				<td>${escapeHtml(entry.language ?? '-')}</td>
				<td>${escapeHtml(entry.submitted_at ?? '-')}</td>
			`;
        statusBody.appendChild(row);
    }
}

loginForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const formData = new FormData(loginForm);
    const username = String(formData.get('username') ?? '');
    const password = String(formData.get('password') ?? '');
    const remember = rememberCheckbox ? rememberCheckbox.checked : true;
    setStatus(loginStatus, '登录中…');
    if (loginPanel) {
        loginPanel.open = true;
    }
    updateLoginSummary('登录中…');
    vscode.postMessage({
        type: 'login',
        payload: { username, password, remember },
    });
});

if (useSavedPasswordButton) {
    useSavedPasswordButton.addEventListener('click', (event) => {
        event.preventDefault();
        if (!state.hasSavedPassword || !state.savedUserId) {
            setStatus(loginStatus, '未找到已保存的密码，请输入密码登录', true);
            return;
        }
        const usernameField = loginForm.querySelector('input[name="username"]');
        let username = state.savedUserId;
        if (usernameField) {
            const typed = usernameField.value.trim();
            if (typed && (!state.savedUserId || typed === state.savedUserId)) {
                username = typed;
            } else {
                usernameField.value = state.savedUserId;
                username = state.savedUserId;
            }
        }
        if (!username) {
            setStatus(loginStatus, '请先填写用户名', true);
            return;
        }
        const remember = rememberCheckbox ? rememberCheckbox.checked : true;
        setStatus(loginStatus, '登录中…');
        if (loginPanel) {
            loginPanel.open = true;
        }
        updateLoginSummary('登录中…');
        vscode.postMessage({
            type: 'login',
            payload: { username, password: '', remember, useSavedPassword: true },
        });
    });
}

problemsetForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const formData = new FormData(problemsetForm);
    const startPage = Number(formData.get('startPage') || 1);
    const maxPagesRaw = formData.get('maxPages');
    const maxPages = maxPagesRaw ? Math.max(1, Number(maxPagesRaw)) : 1;
    state.problemsetRequest = { startPage, maxPages };
    const row = document.createElement('tr');
    row.innerHTML = '<td colspan="4" class="placeholder">题单加载中…</td>';
    problemsetBody.innerHTML = '';
    problemsetBody.appendChild(row);
    state.pendingRestore = false;
    vscode.postMessage({
        type: 'fetchProblemset',
        payload: { startPage, maxPages },
    });
});

problemsetBody.addEventListener('click', (event) => {
    const row = event.target.closest('tr');
    if (!row || !row.dataset.problemId) {
        return;
    }
    const problemId = Number(row.dataset.problemId);
    if (!Number.isFinite(problemId)) {
        return;
    }
    selectProblemById(problemId);
});

detailFileForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!state.currentProblemId) {
        setStatus(fileStatus, '请先选择题目', true);
        return;
    }
    const formData = new FormData(detailFileForm);
    const language = String(formData.get('language'));
    setStatus(fileStatus, '处理中…');
    vscode.postMessage({
        type: 'createFile',
        payload: { problemId: state.currentProblemId, language },
    });
});

detailSubmitForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!state.currentProblemId) {
        renderSubmissionError('请先选择题目再进行提交');
        return;
    }
    const formData = new FormData(detailSubmitForm);
    const language = String(languageSelect.value);
    const filePath = String(formData.get('filePath'));
    state.submission = {
        initial: null,
        final: null,
        loading: true,
        error: null,
    };
    renderSubmissionLoading();
    vscode.postMessage({
        type: 'submitSolution',
        payload: { problemId: state.currentProblemId, language, filePath },
    });
});

statusForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const formData = new FormData(statusForm);
    const limit = Number(formData.get('limit') || 10);
    const row = document.createElement('tr');
    row.innerHTML = '<td colspan="7" class="placeholder">提交记录加载中…</td>';
    statusBody.innerHTML = '';
    statusBody.appendChild(row);
    vscode.postMessage({
        type: 'fetchStatus',
        payload: { limit },
    });
});

if (sampleTestButton) {
    sampleTestButton.addEventListener('click', (event) => {
        event.preventDefault();
        triggerSampleTest();
    });
}

if (problemOutput) {
    problemOutput.addEventListener('click', (event) => {
        const target = event.target.closest('.sample-run-btn');
        if (!target) {
            return;
        }
        event.preventDefault();
        triggerSampleTest();
    });
}

window.addEventListener('message', (event) => {
    const message = event.data;
    switch (message.type) {
        case 'loginSuccess':
            state.loggedIn = true;
            state.pendingRestore = false;
            state.rememberPassword = message.rememberPassword !== false;
            state.hasSavedPassword = Boolean(message.hasSavedPassword);
            state.savedUserId = state.hasSavedPassword ? (message.userId ?? '') : '';
            if (rememberCheckbox) {
                rememberCheckbox.checked = state.rememberPassword;
            }
            const usernameField = loginForm.querySelector('input[name="username"]');
            if (usernameField) {
                usernameField.value = message.userId ?? '';
            }
            const passwordField = loginForm.querySelector('input[name="password"]');
            if (passwordField) {
                passwordField.value = '';
            }
            updateSavedPasswordButton();
            if ('preferredLanguage' in message) {
                setPreferredLanguage(message.preferredLanguage);
            }
            setStatus(loginStatus, `已登录为 ${message.userId}`);
            collapseLoginPanel(message.userId, false);
            clearCurrentProblem({ notifyExtension: false });
            resetSampleTestUI();
            break;
        case 'sessionRestored':
            state.loggedIn = true;
            const numericId = Number(message.currentProblemId);
            state.currentProblemId = Number.isFinite(numericId) ? numericId : null;
            state.rememberPassword = message.rememberPassword !== false;
            state.hasSavedPassword = Boolean(message.hasSavedPassword);
            state.savedUserId = state.hasSavedPassword ? (message.userId ?? '') : '';
            if (rememberCheckbox) {
                rememberCheckbox.checked = state.rememberPassword;
            }
            const restoredUserField = loginForm.querySelector('input[name="username"]');
            if (restoredUserField) {
                restoredUserField.value = message.userId ?? '';
            }
            const restoredPasswordField = loginForm.querySelector('input[name="password"]');
            if (restoredPasswordField) {
                restoredPasswordField.value = '';
            }
            updateSavedPasswordButton();
            if ('preferredLanguage' in message) {
                setPreferredLanguage(message.preferredLanguage);
            }
            const problemsetState = message.problemset ?? null;
            const cachedProblem = message.lastProblem ?? null;
            const cachedProblemValid = Boolean(
                cachedProblem &&
                Number(cachedProblem.problemId) === state.currentProblemId &&
                cachedProblem.data !== undefined &&
                cachedProblem.data !== null,
            );
            state.pendingRestore = state.currentProblemId !== null && !cachedProblemValid;
            if (problemsetState && problemsetState.request) {
                state.problemsetRequest = problemsetState.request;
                restoreProblemsetForm(problemsetState.request);
            }
            setStatus(loginStatus, `已恢复登录：${message.userId}`);
            collapseLoginPanel(message.userId, true);
            if (problemsetState && problemsetState.data) {
                renderProblemset(problemsetState.data);
            } else if (state.currentProblemId === null) {
                clearCurrentProblem({ notifyExtension: false });
            }
            if (cachedProblemValid) {
                renderProblemDetail(cachedProblem.data);
            } else if (state.currentProblemId !== null && !(problemsetState && problemsetState.data)) {
                highlightProblemRow(state.currentProblemId);
            }
            resetSampleTestUI();
            break;
        case 'problemset':
            renderProblemset(message.payload);
            break;
        case 'problem':
            renderProblemDetail(message.payload);
            break;
        case 'status':
            renderStatusTable(message.payload);
            break;
        case 'fileCreated':
            setStatus(fileStatus, `文件已打开：${message.path}`);
            submitFileInput.value = message.path;
            break;
        case 'submission':
            state.submission.initial = message.payload ?? null;
            state.submission.loading = true;
            state.submission.error = null;
            renderSubmissionState();
            break;
        case 'submissionStatus':
            state.submission.final = message.payload ?? null;
            if (state.submission.final && state.submission.initial && !state.submission.final.solution_id) {
                state.submission.final.solution_id = state.submission.initial.solution_id ?? state.submission.initial.solution_id_text;
            }
            state.submission.loading = false;
            state.submission.error = null;
            if (state.currentProblemId !== null && state.submission.final) {
                const finalCode = Number(state.submission.final.result_code);
                if (Number.isFinite(finalCode) && finalCode === 4) {
                    vscode.postMessage({
                        type: 'updateProblemStatus',
                        payload: { problemId: state.currentProblemId, accepted: true },
                    });
                    updateProblemCompletion(state.currentProblemId, true);
                }
            }
            renderSubmissionState();
            break;
        case 'error':
            if (message.context === 'login') {
                setStatus(loginStatus, message.message, true);
                expandLoginPanel();
            } else if (message.context === 'createFile') {
                setStatus(fileStatus, message.message, true);
            } else {
                state.submission.loading = false;
                state.submission.error = message.message;
                renderSubmissionState();
            }
            break;
        case 'savedCredentials':
            state.loggedIn = false;
            state.rememberPassword = message.rememberPassword !== false;
            state.hasSavedPassword = Boolean(message.hasSavedPassword);
            state.savedUserId = state.hasSavedPassword ? (message.userId ?? '') : '';
            if (rememberCheckbox) {
                rememberCheckbox.checked = state.rememberPassword;
            }
            const savedUserField = loginForm.querySelector('input[name="username"]');
            if (savedUserField) {
                savedUserField.value = message.userId ?? '';
            }
            const savedPasswordField = loginForm.querySelector('input[name="password"]');
            if (savedPasswordField) {
                savedPasswordField.value = '';
            }
            updateSavedPasswordButton();
            if ('preferredLanguage' in message) {
                setPreferredLanguage(message.preferredLanguage);
            }
            setStatus(loginStatus, '自动登录未成功，请手动登录', true);
            expandLoginPanel();
            break;
        case 'sampleTestResult':
            renderSampleTestResult(message.payload);
            break;
        default:
            console.warn('未知消息', message);
    }
});

populateLanguages();
expandLoginPanel();
resetSubmissionState();
resetSampleTestUI();
updateSampleTestAvailability();
updateSavedPasswordButton();
syncProblemControls();
