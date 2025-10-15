import * as path from 'path';
import * as vscode from 'vscode';
import { PythonService } from './pythonService';

const SESSION_EXPIRY_MS = 2 * 60 * 60 * 1000; // 2 hours

interface PersistedProblemsetState {
    readonly data: Record<string, unknown>;
    readonly request: { startPage: number; maxPages: number };
}

interface PersistedProblemState {
    readonly problemId: number;
    readonly data: unknown;
    readonly fetchedAt: number;
}

interface PersistedSession {
    savedAt: number;
    cookies: Record<string, string>;
    userId: string;
    currentProblemId?: number;
    problemset?: PersistedProblemsetState;
    lastProblem?: PersistedProblemState;
}

interface SessionState {
    readonly cookies: Record<string, string>;
    readonly userId: string;
}

type WebviewMessage =
    | { type: 'login'; payload: { username: string; password: string } }
    | { type: 'fetchProblemset'; payload: { startPage: number; maxPages?: number | null } }
    | { type: 'fetchProblem'; payload: { problemId: number } }
    | { type: 'fetchStatus'; payload: { limit: number } }
    | { type: 'createFile'; payload: { problemId: number; language: string } }
    | { type: 'submitSolution'; payload: { problemId: number; language: string; filePath: string; contestProblemId?: number | null } }
    | { type: 'selectProblem'; payload: { problemId: number | null } };

export function activate(context: vscode.ExtensionContext) {
    const provider = new OJAssistantProvider(context);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('ojAssistant.dashboard', provider, {
            webviewOptions: { retainContextWhenHidden: true },
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('ojAssistant.openDashboard', () => provider.reveal()),
    );
}

export function deactivate() { }

class OJAssistantProvider implements vscode.WebviewViewProvider {
    private view?: vscode.WebviewView;
    private readonly python: PythonService;
    private session: SessionState | undefined;
    private currentProblemId: number | null = null;
    private sessionRestorePromise: Promise<void> | undefined;
    private readonly stateDirName = '.oj-assistant';
    private readonly stateFileName = 'session.json';
    private warnedMissingWorkspace = false;

    public constructor(private readonly context: vscode.ExtensionContext) {
        this.python = new PythonService(context);
    }

    public resolveWebviewView(webviewView: vscode.WebviewView): void {
        this.view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
        };
        webviewView.webview.onDidReceiveMessage((message: unknown) => {
            void this.handleMessage(message as WebviewMessage);
        });
        webviewView.webview.html = this.renderHtml(webviewView.webview);
        this.sessionRestorePromise = this.tryRestoreSession();
        void this.sessionRestorePromise;
    }

    public reveal(): void {
        if (this.view) {
            this.view.show?.(true);
        } else {
            void vscode.commands.executeCommand('workbench.view.extension.ojAssistant');
        }
    }

    private async handleMessage(message: WebviewMessage): Promise<void> {
        try {
            switch (message.type) {
                case 'login':
                    await this.handleLogin(message.payload.username, message.payload.password);
                    break;
                case 'fetchProblemset':
                    await this.handleFetchProblemset(message.payload.startPage, message.payload.maxPages ?? undefined);
                    break;
                case 'fetchProblem':
                    await this.handleFetchProblem(message.payload.problemId);
                    break;
                case 'fetchStatus':
                    await this.handleFetchStatus(message.payload.limit);
                    break;
                case 'createFile':
                    await this.handleCreateFile(message.payload.problemId, message.payload.language);
                    break;
                case 'submitSolution':
                    await this.handleSubmitSolution(
                        message.payload.problemId,
                        message.payload.language,
                        message.payload.filePath,
                        message.payload.contestProblemId ?? undefined,
                    );
                    break;
                case 'selectProblem':
                    await this.handleSelectProblem(message.payload.problemId);
                    break;
                default:
                    throw new Error(`未知消息类型: ${(message as { type: string }).type}`);
            }
        } catch (error) {
            const messageType = (message as { type: string }).type ?? 'unknown';
            this.postMessage({ type: 'error', message: (error as Error).message, context: messageType });
        }
    }

    private async handleLogin(username: string, password: string): Promise<void> {
        const data = await this.python.execute<{ cookies: Record<string, string> }>('login', {
            username,
            password,
        });
        this.session = { cookies: data.cookies, userId: username };
        this.currentProblemId = null;
        await this.saveSession(this.session, null);
        this.postMessage({ type: 'loginSuccess', userId: username });
    }

    private async handleFetchProblemset(startPage: number, maxPages?: number): Promise<void> {
        const session = await this.ensureSession();
        const normalizedStartPage = Math.max(1, startPage);
        const effectiveMaxPages = typeof maxPages === 'number' && !Number.isNaN(maxPages) ? Math.max(1, maxPages) : 1;
        const data = await this.python.execute<{ problemset: Record<string, unknown> }>('fetch_problemset', {
            cookies: session.cookies,
            start_page: normalizedStartPage,
            max_pages: effectiveMaxPages,
        });
        this.postMessage({ type: 'problemset', payload: data.problemset });
        await this.mutatePersistedSession((persisted) => {
            persisted.problemset = {
                data: data.problemset,
                request: {
                    startPage: normalizedStartPage,
                    maxPages: effectiveMaxPages,
                },
            };
        });
    }

    private async handleFetchProblem(problemId: number): Promise<void> {
        const session = await this.ensureSession();
        this.currentProblemId = problemId;
        const data = await this.python.execute<{ problem: unknown }>('fetch_problem', {
            cookies: session.cookies,
            problem_id: problemId,
        });
        this.postMessage({ type: 'problem', payload: data.problem });
        await this.mutatePersistedSession((persisted) => {
            persisted.currentProblemId = problemId;
            if (data.problem !== undefined) {
                persisted.lastProblem = {
                    problemId,
                    data: data.problem,
                    fetchedAt: Date.now(),
                };
            } else {
                delete persisted.lastProblem;
            }
        });
    }

    private async handleFetchStatus(limit: number): Promise<void> {
        const session = await this.ensureSession();
        const data = await this.python.execute<{ status: unknown }>('fetch_status', {
            cookies: session.cookies,
            user_id: session.userId,
            limit,
        });
        this.postMessage({ type: 'status', payload: data.status });
    }

    private async handleCreateFile(problemId: number, language: string): Promise<void> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            throw new Error('请先打开一个工作区目录');
        }

        const config = vscode.workspace.getConfiguration('ojAssistant');
        const directoryName = config.get<string>('codeDirectory', 'oj-workspace');
        const folderUri = vscode.Uri.joinPath(workspaceFolder.uri, directoryName);
        await this.ensureDirectory(folderUri);

        const extension = this.getExtensionForLanguage(language);
        const fileName = `problem_${problemId}.${extension}`;
        const fileUri = vscode.Uri.joinPath(folderUri, fileName);

        const exists = await this.fileExists(fileUri);
        if (!exists) {
            const template = this.getTemplateForLanguage(language, problemId);
            await vscode.workspace.fs.writeFile(fileUri, Buffer.from(template, 'utf8'));
        }

        const document = await vscode.workspace.openTextDocument(fileUri);
        await vscode.window.showTextDocument(document);

        const relativePath = vscode.workspace.asRelativePath(fileUri);
        this.postMessage({ type: 'fileCreated', path: relativePath });
    }

    private async handleSubmitSolution(problemId: number, language: string, filePath: string, contestProblemId?: number): Promise<void> {
        const session = await this.ensureSession();
        const languageCode = this.getLanguageCode(language);
        const fileUri = this.resolveFileUri(filePath);
        const sourceBuffer = await vscode.workspace.fs.readFile(fileUri);
        const sourceCode = Buffer.from(sourceBuffer).toString('utf8');

        const submission = await this.python.execute<{ submission: { solution_id?: number } }>('submit_solution', {
            cookies: session.cookies,
            user_id: session.userId,
            problem_id: problemId,
            source_code: sourceCode,
            language: languageCode,
            contest_problem_id: contestProblemId ?? 0,
        });

        this.postMessage({ type: 'submission', payload: submission.submission });

        const solutionId = submission.submission.solution_id;
        if (typeof solutionId === 'number') {
            const finalStatus = await this.python.execute<{ status: unknown }>('poll_submission', {
                cookies: session.cookies,
                solution_id: solutionId,
            });
            this.postMessage({ type: 'submissionStatus', payload: finalStatus.status });
        }
    }

    private postMessage(message: Record<string, unknown>): void {
        this.view?.webview.postMessage(message);
    }

    private async ensureSession(): Promise<SessionState> {
        if (this.session) {
            return this.session;
        }
        if (!this.sessionRestorePromise) {
            this.sessionRestorePromise = this.tryRestoreSession();
        }
        await this.sessionRestorePromise;
        if (!this.session) {
            throw new Error('请先登录在线评测系统');
        }
        return this.session;
    }

    private async handleSelectProblem(problemId: number | null): Promise<void> {
        this.currentProblemId = typeof problemId === 'number' ? problemId : null;
        if (!this.session) {
            return;
        }
        await this.updatePersistedCurrentProblem(problemId);
    }

    private getStateDirUri(): vscode.Uri | undefined {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            return undefined;
        }
        return vscode.Uri.joinPath(workspaceFolder.uri, this.stateDirName);
    }

    private getStateFileUri(): vscode.Uri | undefined {
        const dirUri = this.getStateDirUri();
        if (!dirUri) {
            return undefined;
        }
        return vscode.Uri.joinPath(dirUri, this.stateFileName);
    }

    private async ensureStateDirectory(): Promise<vscode.Uri | undefined> {
        const dirUri = this.getStateDirUri();
        if (!dirUri) {
            return undefined;
        }
        await this.ensureDirectory(dirUri);
        return dirUri;
    }

    private async readPersistedSession(): Promise<PersistedSession | undefined> {
        const fileUri = this.getStateFileUri();
        if (!fileUri) {
            return undefined;
        }
        const exists = await this.fileExists(fileUri);
        if (!exists) {
            return undefined;
        }
        try {
            const raw = await vscode.workspace.fs.readFile(fileUri);
            const text = Buffer.from(raw).toString('utf8');
            return JSON.parse(text) as PersistedSession;
        } catch (error) {
            await this.deletePersistedSession();
            void vscode.window.showWarningMessage(`无法读取持久化登录信息，已清除：${(error as Error).message}`);
            return undefined;
        }
    }

    private async writePersistedSession(session: PersistedSession): Promise<void> {
        const fileUri = this.getStateFileUri();
        if (!fileUri) {
            if (!this.warnedMissingWorkspace) {
                this.warnedMissingWorkspace = true;
                void vscode.window.showWarningMessage('未检测到工作区，无法将登录状态写入文件。');
            }
            return;
        }
        this.warnedMissingWorkspace = false;
        const dirUri = await this.ensureStateDirectory();
        if (!dirUri) {
            return;
        }
        const payload = JSON.stringify(session, null, 2);
        await vscode.workspace.fs.writeFile(fileUri, Buffer.from(`${payload}
`, 'utf8'));
    }

    private async deletePersistedSession(): Promise<void> {
        const fileUri = this.getStateFileUri();
        if (!fileUri) {
            return;
        }
        try {
            await vscode.workspace.fs.delete(fileUri);
        } catch (error) {
            if ((error as { code?: string }).code === 'FileNotFound') {
                return;
            }
            throw error;
        }
    }

    private async saveSession(session: SessionState, problemId: number | null): Promise<void> {
        this.currentProblemId = typeof problemId === 'number' ? problemId : null;
        const persist: PersistedSession = {
            savedAt: Date.now(),
            cookies: session.cookies,
            userId: session.userId,
        };
        if (typeof problemId === 'number') {
            persist.currentProblemId = problemId;
        }
        delete persist.problemset;
        delete persist.lastProblem;
        await this.writePersistedSession(persist);
    }

    private async mutatePersistedSession(mutator: (session: PersistedSession) => void): Promise<void> {
        if (!this.session) {
            return;
        }
        let persisted = await this.readPersistedSession();
        if (!persisted) {
            persisted = {
                savedAt: Date.now(),
                cookies: this.session.cookies,
                userId: this.session.userId,
            };
        } else {
            persisted.cookies = this.session.cookies;
            persisted.userId = this.session.userId;
        }
        mutator(persisted);
        await this.writePersistedSession(persisted);
    }

    private async updatePersistedCurrentProblem(problemId: number | null): Promise<void> {
        if (!this.session) {
            return;
        }
        await this.mutatePersistedSession((persisted) => {
            if (typeof problemId === 'number') {
                persisted.currentProblemId = problemId;
                if (persisted.lastProblem && persisted.lastProblem.problemId !== problemId) {
                    delete persisted.lastProblem;
                }
            } else {
                delete persisted.currentProblemId;
                delete persisted.lastProblem;
            }
        });
    }

    private async tryRestoreSession(): Promise<void> {
        if (this.session) {
            return;
        }
        const persisted = await this.readPersistedSession();
        if (!persisted) {
            return;
        }
        if (Date.now() - persisted.savedAt > SESSION_EXPIRY_MS) {
            await this.deletePersistedSession();
            void vscode.window.showInformationMessage('登录状态已超过 2 小时限制，请重新登录。');
            return;
        }
        this.session = { cookies: persisted.cookies, userId: persisted.userId };
        this.currentProblemId = typeof persisted.currentProblemId === 'number' ? persisted.currentProblemId : null;
        this.postMessage({
            type: 'sessionRestored',
            userId: persisted.userId,
            currentProblemId: this.currentProblemId,
            problemset: persisted.problemset,
            lastProblem: persisted.lastProblem,
        });
    }

    private renderHtml(webview: vscode.Webview): string {
        const mediaPath = vscode.Uri.joinPath(this.context.extensionUri, 'media');
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaPath, 'dashboard.js'));
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaPath, 'dashboard.css'));
        const nonce = this.createNonce();

        return `<!DOCTYPE html>
<html lang="zh-cn">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link rel="stylesheet" href="${styleUri}">
	<title>OJ Productivity Assistant</title>
</head>
<body>
	<header>
		<h1>OJ Productivity Assistant</h1>
		<p>连接 2024.jdoj.tech，提升刷题效率。</p>
	</header>
	<main>
        <section class="card collapsible-card" id="login-card">
            <details id="login-panel" open>
                <summary id="login-summary">登录账号（点击展开）</summary>
                <form id="login-form">
                    <label>用户名
                        <input type="text" name="username" required>
                    </label>
                    <label>密码
                        <input type="password" name="password" required>
                    </label>
                    <button type="submit">登录</button>
                </form>
                <div class="status" id="login-status"></div>
            </details>
        </section>
		<section class="card" id="problemset">
			<h2>题目列表</h2>
			<form id="problemset-form">
				<div class="form-row">
					<label>起始页
						<input type="number" name="startPage" min="1" value="1">
					</label>
					<label>最大页数
						<input type="number" name="maxPages" min="1" placeholder="留空表示只获取一页">
					</label>
					<button type="submit">获取题单</button>
				</div>
			</form>
			<div class="table-container">
				<table id="problemset-table">
					<thead>
						<tr>
							<th>编号</th>
							<th>标题</th>
							<th>通过/提交</th>
							<th>通过率</th>
						</tr>
					</thead>
					<tbody>
						<tr>
							<td colspan="4" class="placeholder">登录并点击“获取题单”加载数据</td>
						</tr>
					</tbody>
				</table>
			</div>
		</section>
		<section class="card" id="problem-detail">
			<h2>题目详情</h2>
			<div id="problem-output" class="problem-content">
				<div class="placeholder">在题目列表中选择一题查看详情</div>
			</div>
            <div id="problem-actions" class="hidden">
                <div class="action-block">
                    <h3>代码文件</h3>
                    <form id="detail-file-form" class="inline-form">
                        <label>语言
                            <select name="language" id="language-select"></select>
                        </label>
                        <button type="submit">创建/打开代码文件</button>
                    </form>
                    <div class="status" id="file-status"></div>
                </div>
                <div class="action-block">
                    <h3>提交评测</h3>
                    <form id="detail-submit-form" class="inline-form">
                        <label>代码文件路径
                            <input type="text" name="filePath" placeholder="相对或绝对路径" required>
                        </label>
                        <button type="submit">提交代码</button>
                    </form>
                </div>
			</div>
            <div class="output submission-output" id="submission-output"></div>
		</section>
		<section class="card" id="status">
			<h2>提交记录</h2>
			<form id="status-form">
				<div class="form-row">
					<label>记录条数
						<input type="number" name="limit" min="1" value="10">
					</label>
					<button type="submit">刷新</button>
				</div>
			</form>
			<div class="table-container">
				<table id="status-table">
					<thead>
						<tr>
							<th>编号</th>
							<th>题目</th>
							<th>结果</th>
							<th>耗时</th>
							<th>内存</th>
							<th>语言</th>
							<th>提交时间</th>
						</tr>
					</thead>
					<tbody>
						<tr>
							<td colspan="7" class="placeholder">登录后可刷新提交记录</td>
						</tr>
					</tbody>
				</table>
			</div>
		</section>
	</main>
	<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }

    private createNonce(): string {
        const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        return Array.from({ length: 32 }, () => possible[Math.floor(Math.random() * possible.length)]).join('');
    }

    private async ensureDirectory(uri: vscode.Uri): Promise<void> {
        try {
            await vscode.workspace.fs.stat(uri);
        } catch (error) {
            if ((error as { code?: string }).code === 'FileNotFound') {
                await vscode.workspace.fs.createDirectory(uri);
                return;
            }
            throw error;
        }
    }

    private async fileExists(uri: vscode.Uri): Promise<boolean> {
        try {
            await vscode.workspace.fs.stat(uri);
            return true;
        } catch (error) {
            if ((error as { code?: string }).code === 'FileNotFound') {
                return false;
            }
            throw error;
        }
    }

    private getExtensionForLanguage(language: string): string {
        switch (language) {
            case 'python':
                return 'py';
            case 'cpp':
                return 'cpp';
            case 'java':
                return 'java';
            default:
                return 'txt';
        }
    }

    private getTemplateForLanguage(language: string, problemId: number): string {
        const header = `# Problem ${problemId}\n\n`;
        switch (language) {
            case 'python':
                return `${header}def solve():\n\tpass\n\nif __name__ == "__main__":\n\ttry:\n\t\tsolve()\n\texcept Exception as exc:\n\t\tprint(exc)\n`;
            case 'cpp':
                return `${header}#include <bits/stdc++.h>\nusing namespace std;\n\nint main() {\n\tios::sync_with_stdio(false);\n\tcin.tie(nullptr);\n\treturn 0;\n}\n`;
            case 'java':
                return `${header}import java.io.BufferedReader;\nimport java.io.IOException;\nimport java.io.InputStreamReader;\nimport java.util.StringTokenizer;\n\npublic class Main {\n\tpublic static void main(String[] args) throws Exception {\n\t\ttry (BufferedReader reader = new BufferedReader(new InputStreamReader(System.in))) {\n\t\t\tStringTokenizer tokenizer = new StringTokenizer(reader.readLine());\n\t\t}\n\t}\n}\n`;
            default:
                return header;
        }
    }

    private getLanguageCode(language: string): number {
        switch (language) {
            case 'python':
                return 6;
            case 'java':
                return 3;
            case 'cpp':
                return 1;
            default:
                return 6;
        }
    }

    private resolveFileUri(filePath: string): vscode.Uri {
        if (path.isAbsolute(filePath)) {
            return vscode.Uri.file(filePath);
        }
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            throw new Error('请提供绝对路径或在工作区内使用相对路径');
        }
        return vscode.Uri.joinPath(workspaceFolder.uri, filePath);
    }
}
