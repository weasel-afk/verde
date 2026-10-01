local ChangeHistoryService = game:GetService("ChangeHistoryService")

local ChangeHistoryHelper = {}

local pendingOperations: { [string]: { operationFuncs: { () -> () }, timer: thread?, displayName: string? } } = {}
local COALESCE_DEBOUNCE_TIME = 0.1

local function commitPendingOperations(operationName: string)
	local pending = pendingOperations[operationName]
	if not pending then
		return
	end

	local recording = ChangeHistoryService:TryBeginRecording(operationName, pending.displayName)
	if not recording then
		warn("Failed to begin recording for coalesced operations:", operationName)
		pendingOperations[operationName] = nil
		return
	end

	local success = true
	local errorMessage = nil

	for _, operationFunc in pending.operationFuncs do
		local opSuccess, opError = pcall(operationFunc)
		if not opSuccess then
			success = false
			errorMessage = opError
			break
		end
	end

	if success then
		ChangeHistoryService:FinishRecording(recording, Enum.FinishRecordingOperation.Commit)
	else
		ChangeHistoryService:FinishRecording(recording, Enum.FinishRecordingOperation.Cancel)
		warn("Failed to execute coalesced operations:", operationName, errorMessage)
	end

	pendingOperations[operationName] = nil
end

function ChangeHistoryHelper.RecordOperation(
	name: string,
	displayName: string?,
	operationFunc: () -> ()
): (boolean, string?)
	if not pendingOperations[name] then
		pendingOperations[name] = {
			operationFuncs = {},
			timer = nil,
			displayName = displayName,
		}
	end

	local pending = pendingOperations[name]

	table.insert(pending.operationFuncs, operationFunc)

	if pending.timer then
		task.cancel(pending.timer)
	end

	pending.timer = task.delay(COALESCE_DEBOUNCE_TIME, function()
		commitPendingOperations(name)
	end)

	return true
end

function ChangeHistoryHelper.RecordBatch(
	name: string,
	displayName: string?,
	operationFunc: () -> ...any
): (boolean, string?, ...any)
	local recording = ChangeHistoryService:TryBeginRecording(name, displayName)

	if not recording then
		warn("Failed to begin recording; applying changes without undo entry:", name)
		local unwrapped = table.pack(pcall(operationFunc))
		if unwrapped[1] then
			return true, nil, table.unpack(unwrapped, 2, unwrapped.n)
		end
		return false, tostring(unwrapped[2])
	end

	local results = table.pack(pcall(operationFunc))

	if results[1] then
		pcall(function()
			ChangeHistoryService:FinishRecording(recording, Enum.FinishRecordingOperation.Commit)
		end)
		return true, nil, table.unpack(results, 2, results.n)
	end

	pcall(function()
		ChangeHistoryService:FinishRecording(recording, Enum.FinishRecordingOperation.Cancel)
	end)
	warn("Failed to execute batched operation:", name, results[2])
	return false, tostring(results[2])
end

function ChangeHistoryHelper.IsRecordingInProgress(): boolean
	return ChangeHistoryService:IsRecordingInProgress() ~= nil
end

function ChangeHistoryHelper.GetCanUndo(): (boolean, string?)
	local canUndo, operationName = ChangeHistoryService:GetCanUndo()
	return canUndo, operationName
end

function ChangeHistoryHelper.GetCanRedo(): (boolean, string?)
	local canRedo, operationName = ChangeHistoryService:GetCanRedo()
	return canRedo, operationName
end

function ChangeHistoryHelper.Undo()
	ChangeHistoryService:Undo()
end

function ChangeHistoryHelper.Redo()
	ChangeHistoryService:Redo()
end

-- Force commit all pending operations (useful for cleanup)
function ChangeHistoryHelper.CommitPendingOperations()
	for operationName, _ in pendingOperations do
		if pendingOperations[operationName].timer then
			task.cancel(pendingOperations[operationName].timer)
		end
		commitPendingOperations(operationName)
	end
end

return ChangeHistoryHelper
