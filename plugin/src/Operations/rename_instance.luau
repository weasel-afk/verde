local ChangeHistoryHelper = require(script.Parent.Parent.Shared.ChangeHistoryService)
local InstanceMap = require(script.Parent.Parent.Shared.InstanceMap)
local error = require(script.Parent.Parent.Utils.error)

return function(payload: { nodeId: string, newName: string }): boolean
	local nodeId = payload.nodeId
	local newName = payload.newName

	local instance = assert(InstanceMap[nodeId], "instance not found: " .. nodeId)

	if type(newName) ~= "string" or newName == "" then
		error("invalid name")
	end

	local success, errorMessage = ChangeHistoryHelper.RecordOperation("RenameInstance", "Rename Instance", function()
		instance.Name = newName
	end)

	if not success then
		error(errorMessage or "Failed to record rename operation")
	end

	return true
end
