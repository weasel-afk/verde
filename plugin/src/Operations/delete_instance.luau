local ChangeHistoryHelper = require(script.Parent.Parent.Shared.ChangeHistoryService)
local InstanceMap = require(script.Parent.Parent.Shared.InstanceMap)

return function(payload: { nodeId: string }): boolean
	local nodeId = payload.nodeId

	local instance = assert(InstanceMap[nodeId], "instance not found: " .. nodeId)

	local success, errorMessage = ChangeHistoryHelper.RecordOperation("DeleteInstance", "Delete Instance", function()
		instance.Parent = nil
	end)

	if not success then
		error(errorMessage or "Failed to record delete operation")
	end

	return true
end
