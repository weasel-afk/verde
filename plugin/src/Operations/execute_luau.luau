-- SECURITY NOTE: this is NOT a sandbox. There are some safeguards but users must trust the code themselves.

local HttpService = game:GetService("HttpService")
local ChangeHistoryService = game:GetService("ChangeHistoryService")

local InstanceMap = require(script.Parent.Parent.Shared.InstanceMap)

type Payload = {
	code: string,
	description: string?,
	nodeId: string?,
	extensionId: string?,
}

local function sanitizeId(raw: string?): string
	if not raw or raw == "" then
		return "extension"
	end
	local cleaned = (raw:gsub("[%c\r\n]", ""))
	cleaned = (cleaned:gsub("^%s+", ""):gsub("%s+$", ""))
	if cleaned == "" then
		return "extension"
	end
	if #cleaned > 128 then
		cleaned = cleaned:sub(1, 128)
	end
	return cleaned
end

return function(payload: Payload): (any, string?)
	if type(payload.code) ~= "string" or payload.code == "" then
		return false, "execute_luau: missing code"
	end

	local extensionId = sanitizeId(payload.extensionId)
	local description = payload.description or `Verde: {extensionId}`

	local selection: Instance? = nil
	if payload.nodeId then
		selection = InstanceMap[payload.nodeId]
		if not selection then
			return false, `execute_luau: instance not found: {payload.nodeId}`
		end
	end

	local wrapped = `return function(ctx)\n{payload.code}\nend`
	local loader, loadError = loadstring(wrapped, `=verde: {extensionId}`)
	if not loader then
		return false, `execute_luau: compile failed: {tostring(loadError)}`
	end

	local topOk, fnOrErr = pcall(loader)
	if not topOk then
		return false, `execute_luau: top-level error: {tostring(fnOrErr)}`
	end
	if type(fnOrErr) ~= "function" then
		return false, "execute_luau: wrapper did not return a function"
	end
	local userFn = fnOrErr

	local ctx = {
		selection = selection,
		extensionId = extensionId,
	}

	local recording = ChangeHistoryService:TryBeginRecording(`ExecuteLuau: {extensionId}`, description)
	if not recording then
		return false,
			"execute_luau: ChangeHistoryService is busy. Another Verde operation or "
				.. "Studio recording is in progress; retry after it completes."
	end

	local userResult: any
	local runOk, runErr = pcall(function()
		userResult = userFn(ctx)
	end)

	if not runOk then
		ChangeHistoryService:FinishRecording(recording, Enum.FinishRecordingOperation.Cancel)
		return false, `execute_luau: script error: {tostring(runErr)}`
	end

	ChangeHistoryService:FinishRecording(recording, Enum.FinishRecordingOperation.Commit)

	if userResult ~= nil then
		local encodeOk, encodeErr = pcall(function()
			HttpService:JSONEncode(userResult)
		end)
		if not encodeOk then
			return false, `execute_luau: return value not JSON-serializable: {tostring(encodeErr)}`
		end
	end

	return { value = userResult }
end
