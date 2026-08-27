import { useCallback, useReducer } from "react"

export interface AttachmentPath {
  path: string
  label?: string
  error?: string
  progress?: number
  status?: "error" | "ready" | "uploading"
}

export type ComposerStatus =
  | { status: "idle" }
  | { status: "sending" }
  | { status: "error"; message: string }

interface ComposerModel {
  draft: string
  attachments: AttachmentPath[]
  attachmentPathInput: string
  attachmentInputOpen: boolean
  status: ComposerStatus
}

type ComposerAction =
  | { type: "draft"; value: string }
  | { type: "attachment.input"; value: string }
  | { type: "attachment.toggle" }
  | { type: "attachment.add"; attachment: AttachmentPath }
  | { type: "attachment.error"; message: string; path: string }
  | { type: "attachment.progress"; path: string; progress: number }
  | { type: "attachment.upload"; label: string; path: string }
  | { type: "attachment.uploaded"; path: string; storedPath: string }
  | { type: "attachment.remove"; path: string }
  | { type: "attachment.errors"; message: string }
  | { type: "status"; status: ComposerStatus }
  | { type: "sent" }

const initialComposerModel: ComposerModel = {
  attachmentInputOpen: false,
  attachmentPathInput: "",
  attachments: [],
  draft: "",
  status: { status: "idle" },
}

function composerReducer(state: ComposerModel, action: ComposerAction): ComposerModel {
  switch (action.type) {
    case "draft":
      return { ...state, draft: action.value, status: { status: "idle" } }
    case "attachment.input":
      return { ...state, attachmentPathInput: action.value }
    case "attachment.toggle":
      return { ...state, attachmentInputOpen: !state.attachmentInputOpen }
    case "attachment.add":
      return {
        ...state,
        attachmentPathInput: "",
        attachments: [...state.attachments, { status: "ready", ...action.attachment }],
      }
    case "attachment.upload":
      return {
        ...state,
        attachments: [
          ...state.attachments,
          { label: action.label, path: action.path, progress: 0, status: "uploading" },
        ],
      }
    case "attachment.progress":
      return {
        ...state,
        attachments: state.attachments.map((attachment) =>
          attachment.path === action.path ? { ...attachment, progress: action.progress } : attachment,
        ),
      }
    case "attachment.uploaded":
      return {
        ...state,
        attachments: state.attachments.map((attachment) =>
          attachment.path === action.path
            ? { ...attachment, path: action.storedPath, progress: 100, status: "ready" }
            : attachment,
        ),
      }
    case "attachment.error":
      return {
        ...state,
        attachments: state.attachments.map((attachment) =>
          attachment.path === action.path
            ? { ...attachment, error: action.message, status: "error" }
            : attachment,
        ),
      }
    case "attachment.remove": {
      const index = state.attachments.findIndex((attachment) => attachment.path === action.path)
      if (index < 0) return state
      return {
        ...state,
        attachments: [...state.attachments.slice(0, index), ...state.attachments.slice(index + 1)],
      }
    }
    case "attachment.errors":
      return {
        ...state,
        attachments: state.attachments.map((attachment) => ({
          ...attachment,
          error: action.message,
          status: "error",
        })),
      }
    case "status":
      return { ...state, status: action.status }
    case "sent":
      return { ...state, attachments: [], draft: "", status: { status: "idle" } }
  }
}

export interface ComposerController extends ComposerModel {
  addAttachmentPath: () => void
  addUploadPlaceholder: (path: string, label: string) => void
  handleAttachmentInputChange: (value: string) => void
  markAttachmentErrors: (message: string) => void
  markUploadError: (path: string, message: string) => void
  removeAttachmentPath: (path: string) => void
  setDraft: (value: string) => void
  setStatus: (status: ComposerStatus) => void
  markSent: () => void
  setUploadProgress: (path: string, progress: number) => void
  toggleAttachmentInput: () => void
  completeUpload: (path: string, storedPath: string) => void
}

export function useComposerState(): ComposerController {
  const [state, dispatch] = useReducer(composerReducer, initialComposerModel)

  const setDraft = useCallback((value: string) => dispatch({ type: "draft", value }), [])
  const handleAttachmentInputChange = useCallback(
    (value: string) => dispatch({ type: "attachment.input", value }),
    [],
  )
  const addAttachmentPath = useCallback(() => {
    const path = state.attachmentPathInput.trim()
    if (path.length === 0) return
    const error = path.startsWith("/") ? undefined : "Use an absolute path."
    dispatch({ attachment: { error, path, status: error === undefined ? "ready" : "error" }, type: "attachment.add" })
  }, [state.attachmentPathInput])
  const addUploadPlaceholder = useCallback((path: string, label: string) => {
    dispatch({ label, path, type: "attachment.upload" })
  }, [])
  const removeAttachmentPath = useCallback((path: string) => {
    dispatch({ path, type: "attachment.remove" })
  }, [])
  const markAttachmentErrors = useCallback((message: string) => {
    dispatch({ message, type: "attachment.errors" })
  }, [])
  const markUploadError = useCallback((path: string, message: string) => {
    dispatch({ message, path, type: "attachment.error" })
  }, [])
  const setStatus = useCallback((status: ComposerStatus) => dispatch({ status, type: "status" }), [])
  const markSent = useCallback(() => dispatch({ type: "sent" }), [])
  const setUploadProgress = useCallback((path: string, progress: number) => {
    dispatch({ path, progress, type: "attachment.progress" })
  }, [])
  const completeUpload = useCallback((path: string, storedPath: string) => {
    dispatch({ path, storedPath, type: "attachment.uploaded" })
  }, [])
  const toggleAttachmentInput = useCallback(() => dispatch({ type: "attachment.toggle" }), [])

  return {
    ...state,
    addAttachmentPath,
    addUploadPlaceholder,
    completeUpload,
    handleAttachmentInputChange,
    markAttachmentErrors,
    markUploadError,
    markSent,
    removeAttachmentPath,
    setDraft,
    setStatus,
    setUploadProgress,
    toggleAttachmentInput,
  }
}
