import {
	App,
	Editor,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TextComponent,
	EditorPosition,
	setIcon,
	FileSystemAdapter,
	RequestUrlParam,
	requestUrl,
	DataAdapter,
	FrontMatterCache,
} from "obsidian";
import { HttpRequest, HttpResponse } from "@aws-sdk/protocol-http";
import { HttpHandlerOptions } from "@aws-sdk/types";
import { buildQueryString } from "@aws-sdk/querystring-builder";
import { requestTimeout } from "@smithy/fetch-http-handler/dist-es/request-timeout";
import {
	FetchHttpHandler,
	FetchHttpHandlerOptions,
} from "@smithy/fetch-http-handler";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import * as crypto from "crypto";

interface pasteFunction {
	(this: HTMLElement, event: ClipboardEvent | DragEvent): void;
}

interface S3UploaderSettings {
	accessKey: string;
	secretKey: string;
	region: string;
	bucket: string;
	folder: string;
	imageUrlPath: string;
	uploadOnDrag: boolean;
	localUpload: boolean;
	localUploadFolder: string;
	useCustomEndpoint: boolean;
	customEndpoint: string;
	forcePathStyle: boolean;
	useCustomImageUrl: boolean;
	customImageUrl: string;
	uploadVideo: boolean;
	uploadAudio: boolean;
	uploadPdf: boolean;
	bypassCors: boolean;
}

const DEFAULT_SETTINGS: S3UploaderSettings = {
	accessKey: "",
	secretKey: "",
	region: "",
	bucket: "",
	folder: "",
	imageUrlPath: "",
	uploadOnDrag: true,
	localUpload: false,
	localUploadFolder: "",
	useCustomEndpoint: false,
	customEndpoint: "",
	forcePathStyle: false,
	useCustomImageUrl: false,
	customImageUrl: "",
	uploadVideo: false,
	uploadAudio: false,
	uploadPdf: false,
	bypassCors: false,
};

export default class S3UploaderPlugin extends Plugin {
	settings: S3UploaderSettings;
	s3: S3Client;
	pasteFunction: pasteFunction;

	private replaceText(
		editor: Editor,
		target: string,
		replacement: string
	): void {
		target = target.trim();
		const lines = editor.getValue().split("\n");
		for (let i = 0; i < lines.length; i++) {
			const ch = lines[i].indexOf(target);
			if (ch !== -1) {
				const from = { line: i, ch: ch } as EditorPosition;
				const to = {
					line: i,
					ch: ch + target.length,
				} as EditorPosition;
				editor.setCursor(from);
				editor.replaceRange(replacement, from, to);
				break;
			}
		}
	}

	getFileType(
		file: File,
		uploadVideo: any,
		uploadAudio: any,
		uploadPdf: any
	) {
		const type = file.type;
		if (type.startsWith("video/") && uploadVideo) return "video";
		if (type.startsWith("audio/") && uploadAudio) return "audio";
		if (type === "application/pdf" && uploadPdf) return "pdf";
		if (type.startsWith("image/")) return "image";
		return null; // Unsupported file type
	}

	getFolderPath(
		fm: FrontMatterCache | undefined,
		localUpload: boolean,
		currentDate: Date
	): string {
		let baseFolder = localUpload
			? this.settings.localUploadFolder
			: this.settings.folder;
		baseFolder = baseFolder.trim();
		if (fm) {
			baseFolder =
				(localUpload ? fm.localUploadFolder : fm.folder) || baseFolder;
		}
		return baseFolder
			.replace("${year}", currentDate.getFullYear().toString())
			.replace(
				"${month}",
				String(currentDate.getMonth() + 1).padStart(2, "0")
			)
			.replace("${day}", String(currentDate.getDate()).padStart(2, "0"));
	}

	async uploadFile(
		localUpload: boolean,
		file: File,
		key: string,
		buf: ArrayBuffer
	): Promise<string> {
		const buffer = new Uint8Array(buf); // Convert to Uint8Array if not already

		if (!localUpload) {
			await this.s3.send(
				new PutObjectCommand({
					Bucket: this.settings.bucket,
					Key: key,
					Body: buffer,
					ContentType: file.type,
				})
			);
			return `${this.settings.imageUrlPath}${key}`;
		} else {
			// Ensure the local folder exists (create if it doesn't)
			const folderPath = key.substring(0, key.lastIndexOf("/"));
			if (
				!(await this.app.vault.adapter.exists(folderPath)) &&
				folderPath
			) {
				await this.app.vault.createFolder(folderPath);
			}
			await this.app.vault.adapter.writeBinary(key, buffer);
			// In Obsidian, local files should be linked relative to the vault root, without leading '/'
			return key.startsWith("/") ? key.slice(1) : key;
		}
	}

	async pasteHandler(
		ev: ClipboardEvent | DragEvent,
		editor: Editor
	): Promise<void> {
		if (ev.defaultPrevented) {
			return;
		}

		const noteFile = this.app.workspace.getActiveFile();
		if (!noteFile || !noteFile.name) return;

		// Handle frontmatter settings
		const fm = this.app.metadataCache.getFileCache(noteFile)?.frontmatter;
		const localUpload =
			typeof fm?.localUpload !== "undefined"
				? fm.localUpload
				: this.settings.localUpload;
		const uploadVideo =
			typeof fm?.uploadVideo !== "undefined"
				? fm.uploadVideo
				: this.settings.uploadVideo;
		const uploadAudio =
			typeof fm?.uploadAudio !== "undefined"
				? fm.uploadAudio
				: this.settings.uploadAudio;
		const uploadPdf =
			typeof fm?.uploadPdf !== "undefined"
				? fm.uploadPdf
				: this.settings.uploadPdf;
		const uploadOnDrag =
			typeof fm?.uploadOnDrag !== "undefined"
				? fm.uploadOnDrag
				: this.settings.uploadOnDrag;

		if (ev.type === "drop" && !uploadOnDrag) {
			return;
		}

		let files: File[] = [];
		if (ev.type === "paste") {
			files = Array.from(
				(ev as ClipboardEvent).clipboardData?.files || []
			);
		} else if (ev.type === "drop") {
			files = Array.from((ev as DragEvent).dataTransfer?.files || []);
		}

		if (files.length > 0) {
			ev.preventDefault();
			const uploads = files.map(async (file) => {
				const thisType = this.getFileType(
					file,
					uploadVideo,
					uploadAudio,
					uploadPdf
				);
				if (!thisType) return; // Skip unsupported file types

				const buf = await file.arrayBuffer();
				const digest = crypto
					.createHash("md5")
					.update(new Uint8Array(buf))
					.digest("hex");
				const newFileName = `${digest}.${file.name.split(".").pop()}`;
				const placeholder = `![uploading...](${newFileName})\n`;
				editor.replaceSelection(placeholder);

				let folder = this.getFolderPath(fm, localUpload, new Date());
				const key = folder ? `${folder}/${newFileName}` : newFileName;

				try {
					let url = await this.uploadFile(
						localUpload,
						file,
						key,
						buf
					);
					const imgMarkdownText = wrapFileDependingOnType(
						url,
						thisType,
						localUpload ? this.settings.localUploadFolder : ""
					);
					this.replaceText(editor, placeholder, imgMarkdownText);
				} catch (error) {
					console.error(error);
					this.replaceText(
						editor,
						placeholder,
						`Error uploading file: ${error.message}\n`
					);
				}
			});

			await Promise.all(uploads).then(() => {
				new Notice("All files processed.");
			});
		}
	}

	async onload() {
		await this.loadSettings();

		// Add the settings tab
		this.addSettingTab(new S3UploaderSettingTab(this.app, this));

		// Configure the S3 client
		let apiEndpoint = this.settings.useCustomEndpoint
			? this.settings.customEndpoint
			: `https://s3.${this.settings.region}.amazonaws.com/`;
		this.settings.imageUrlPath = this.settings.useCustomImageUrl
			? this.settings.customImageUrl
			: this.settings.forcePathStyle
			? apiEndpoint + this.settings.bucket + "/"
			: apiEndpoint.replace("://", `://${this.settings.bucket}.`);

		this.s3 = new S3Client({
			region: this.settings.region,
			credentials: {
				accessKeyId: this.settings.accessKey,
				secretAccessKey: this.settings.secretKey,
			},
			endpoint: apiEndpoint,
			forcePathStyle: this.settings.forcePathStyle,
			requestHandler: new ObsHttpHandler({ keepAlive: false }),
		});

		// Bind the paste and drop functions
		this.pasteFunction = this.pasteHandler.bind(this);
		this.registerEvent(
			this.app.workspace.on("editor-paste", this.pasteFunction)
		);
		this.registerEvent(
			this.app.workspace.on("editor-drop", this.pasteFunction)
		);
	}

	onunload() {}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class S3UploaderSettingTab extends PluginSettingTab {
	plugin: S3UploaderPlugin;

	constructor(app: App, plugin: S3UploaderPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		containerEl.createEl("h2", { text: "Settings for S3 Image Uploader" });

		containerEl.createEl("br");

		const coffeeDiv = containerEl.createDiv("coffee");
		const coffeeLink = coffeeDiv.createEl("a", {
			href: "https://www.buymeacoffee.com/jvsteiner",
		});
		const coffeeImg = coffeeLink.createEl("img", {
			attr: {
				src: "https://cdn.buymeacoffee.com/buttons/v2/default-blue.png",
			},
		});
		coffeeImg.height = 45;
		containerEl.createEl("br");

		new Setting(containerEl)
			.setName("AWS Access Key ID")
			.setDesc("AWS access key ID for a user with S3 access.")
			.addText((text) => {
				wrapTextWithPasswordHide(text);
				text.setPlaceholder("access key")
					.setValue(this.plugin.settings.accessKey)
					.onChange(async (value) => {
						this.plugin.settings.accessKey = value.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("AWS Secret Key")
			.setDesc("AWS secret key for that user.")
			.addText((text) => {
				wrapTextWithPasswordHide(text);
				text.setPlaceholder("secret key")
					.setValue(this.plugin.settings.secretKey)
					.onChange(async (value) => {
						this.plugin.settings.secretKey = value.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Region")
			.setDesc("AWS region of the S3 bucket.")
			.addText((text) =>
				text
					.setPlaceholder("aws region")
					.setValue(this.plugin.settings.region)
					.onChange(async (value) => {
						this.plugin.settings.region = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("S3 Bucket")
			.setDesc("S3 bucket name.")
			.addText((text) =>
				text
					.setPlaceholder("bucket name")
					.setValue(this.plugin.settings.bucket)
					.onChange(async (value) => {
						this.plugin.settings.bucket = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Bucket folder")
			.setDesc(
				"Optional folder in s3 bucket. Support the use of ${year}, ${month}, and ${day} variables."
			)
			.addText((text) =>
				text
					.setPlaceholder("folder")
					.setValue(this.plugin.settings.folder)
					.onChange(async (value) => {
						this.plugin.settings.folder = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Upload on drag")
			.setDesc(
				"Upload drag and drop images as well as pasted images. To override this setting on a per-document basis, you can add `uploadOnDrag: true` to YAML frontmatter of the note."
			)
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.uploadOnDrag)
					.onChange(async (value) => {
						this.plugin.settings.uploadOnDrag = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Upload video files")
			.setDesc(
				"Upload videos. To override this setting on a per-document basis, you can add `uploadVideo: true` to YAML frontmatter of the note."
			)
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.uploadVideo)
					.onChange(async (value) => {
						this.plugin.settings.uploadVideo = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Upload audio files")
			.setDesc(
				"Upload audio files. To override this setting on a per-document basis, you can add `uploadAudio: true` to YAML frontmatter of the note."
			)
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.uploadAudio)
					.onChange(async (value) => {
						this.plugin.settings.uploadAudio = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Upload pdf files")
			.setDesc(
				"Upload and embed PDF files. To override this setting on a per-document basis, you can add `uploadPdf: true` to YAML frontmatter of the note. Local uploads are not supported for PDF files."
			)
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.uploadPdf)
					.onChange(async (value) => {
						this.plugin.settings.uploadPdf = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Copy to local folder")
			.setDesc(
				"Copy images to a local folder (valut root) instead of s3. To override this setting on a per-document basis, you can add `localUpload: true` to YAML frontmatter of the note.  This will copy the images to a folder in your local file system, instead of s3."
			)
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.localUpload)
					.onChange(async (value) => {
						this.plugin.settings.localUpload = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Local folder")
			.setDesc(
				'The local folder in your vault to save images, instead of s3. To override this setting on a per-document basis, you can add `localUploadFolder: "myFolder"` to YAML frontmatter of the note.  This affects only local uploads.'
			)
			.addText((text) =>
				text
					.setPlaceholder("folder")
					.setValue(this.plugin.settings.localUploadFolder)
					.onChange(async (value) => {
						this.plugin.settings.localUploadFolder = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Use custom endpoint")
			.setDesc("Use the custom api endpoint below.")
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.useCustomEndpoint)
					.onChange(async (value) => {
						this.plugin.settings.useCustomEndpoint = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Custom S3 Endpoint")
			.setDesc(
				"Optionally set a custom endpoint for any S3 compatible storage provider."
			)
			.addText((text) =>
				text
					.setPlaceholder("https://s3.myhost.com/")
					.setValue(this.plugin.settings.customEndpoint)
					.onChange(async (value) => {
						value = value.match(/https?:\/\//) // Force to start http(s)://
							? value
							: "https://" + value;
						value = value.replace(/([^\/])$/, "$1/"); // Force to end with slash
						this.plugin.settings.customEndpoint = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("S3 Path Style URLs")
			.setDesc(
				"Advanced option to force using (legacy) path-style s3 URLs (s3.myhost.com/bucket) instead of the modern AWS standard host-style (bucket.s3.myhost.com)."
			)
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.forcePathStyle)
					.onChange(async (value) => {
						this.plugin.settings.forcePathStyle = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Use custom image URL")
			.setDesc("Use the custom image URL below.")
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.useCustomImageUrl)
					.onChange(async (value) => {
						this.plugin.settings.useCustomImageUrl = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Custom Image URL")
			.setDesc(
				"Advanced option to force inserting custom image URLs. This option is helpful if you are using CDN."
			)
			.addText((text) =>
				text
					.setValue(this.plugin.settings.customImageUrl)
					.onChange(async (value) => {
						value = value.match(/https?:\/\//) // Force to start http(s)://
							? value
							: "https://" + value;
						value = value.replace(/([^\/])$/, "$1/"); // Force to end with slash
						this.plugin.settings.customImageUrl = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Bypass local CORS check")
			.setDesc(
				"Bypass local CORS preflight checks - it might work on later versions of Obsidian."
			)
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.bypassCors)
					.onChange(async (value) => {
						this.plugin.settings.bypassCors = value;
						await this.plugin.saveSettings();
					});
			});
	}
}
// Utility functions
const wrapTextWithPasswordHide = (text: TextComponent) => {
	const hider = text.inputEl.insertAdjacentElement(
		"beforebegin",
		createSpan()
	);
	if (!hider) {
		return;
	}
	setIcon(hider as HTMLElement, "eye-off");
	hider.addEventListener("click", () => {
		const isText = text.inputEl.getAttribute("type") === "text";
		text.inputEl.setAttribute("type", isText ? "password" : "text");
		setIcon(hider as HTMLElement, isText ? "eye" : "eye-off");
		text.inputEl.focus();
	});
	text.inputEl.setAttribute("type", "password");
	return text;
};

const wrapFileDependingOnType = (
	location: string,
	type: string,
	localBase: string
) => {
	const srcPrefix = localBase ? `file://${localBase}/` : "";
	switch (type) {
		case "image":
			return `![image](${location})`;
		case "video":
			return `<video src="${srcPrefix}${location}" controls />`;
		case "audio":
			return `<audio src="${srcPrefix}${location}" controls />`;
		case "pdf":
			return `<iframe frameborder="0" border="0" width="100%" height="800" src="${location}"></iframe>`;
		default:
			throw new Error("Unknown file type");
	}
};

// Handler for Obsidian's requestUrl method
class ObsHttpHandler extends FetchHttpHandler {
	requestTimeoutInMs: number | undefined;

	constructor(options?: FetchHttpHandlerOptions) {
		super(options);
		this.requestTimeoutInMs = options?.requestTimeout;
	}

	async handle(
		request: HttpRequest,
		options: HttpHandlerOptions = {}
	): Promise<{ response: HttpResponse }> {
		if (options.abortSignal?.aborted) {
			throw new Error("Request aborted");
		}

		let path = request.path;
		if (request.query) {
			path += `?${buildQueryString(request.query)}`;
		}

		const url = `${request.protocol}//${request.hostname}${
			request.port ? `:${request.port}` : ""
		}${path}`;
		const headers = Object.fromEntries(
			Object.entries(request.headers).filter(
				([key]) =>
					!["host", "content-length"].includes(key.toLowerCase())
			)
		);

		const body =
			request.method === "GET" || request.method === "HEAD"
				? undefined
				: request.body;
		const contentType = headers["content-type"];

		const transformedBody = ArrayBuffer.isView(body)
			? bufferToArrayBuffer(body)
			: body;

		const responsePromise = requestUrl({
			url,
			method: request.method,
			body: transformedBody,
			headers,
			contentType,
		});

		return Promise.race([
			responsePromise.then((rsp) => ({
				response: new HttpResponse({
					statusCode: rsp.status,
					headers: Object.fromEntries(
						Object.entries(rsp.headers).map(([k, v]) => [
							k.toLowerCase(),
							v,
						])
					),
					body: rsp.arrayBuffer
						? new ReadableStream<Uint8Array>({
								start(controller) {
									controller.enqueue(
										new Uint8Array(rsp.arrayBuffer)
									);
									controller.close();
								},
						  })
						: undefined,
				}),
			})),
			requestTimeout(this.requestTimeoutInMs),
		]);
	}
}

const bufferToArrayBuffer = (
	buffer: Buffer | Uint8Array | ArrayBufferView
): ArrayBuffer => {
	return buffer.buffer.slice(
		buffer.byteOffset,
		buffer.byteOffset + buffer.byteLength
	);
};
