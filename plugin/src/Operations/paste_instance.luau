local ChangeHistoryHelper = require(script.Parent.Parent.Shared.ChangeHistoryService)
local InstanceMap = require(script.Parent.Parent.Shared.InstanceMap)
local Clipboard = require(script.Parent.Parent.Shared.Clipboard)
local NameUtils = require(script.Parent.Parent.Utils.name)

return function(payload: { targetNodeId: string? }): boolean
	local targetNodeId = payload.targetNodeId

	local targetParent = nil

	if targetNodeId then
		targetParent = assert(InstanceMap[targetNodeId], "target not found: " .. targetNodeId)
	else
		targetParent = game
	end

	-- nothing to copy
	if #Clipboard == 0 then
		return true
	end

	local pastedInstances = {}

	for _, clipboardContent in Clipboard do
		local pastedInstance = clipboardContent:Clone()

		local baseName, _ = NameUtils.ParseName(pastedInstance.Name)
		local newName = NameUtils.GetValidName(targetParent, baseName)

		pastedInstance.Name = newName
		table.insert(pastedInstances, pastedInstance)
	end

	local success, errorMessage = ChangeHistoryHelper.RecordOperation("PasteInstance", "Paste Instance", function()
		for _, pastedInstance in pastedInstances do
			pastedInstance.Parent = targetParent
		end
	end)

	if not success then
		for _, pastedInstance in pastedInstances do
			pastedInstance:Destroy()
		end
		error(errorMessage or "Failed to record paste operation")
	end

	for _, pastedInstance in pastedInstances do
		local newId = pastedInstance:GetDebugId(0)
		InstanceMap[newId] = pastedInstance
	end

	return true
end
