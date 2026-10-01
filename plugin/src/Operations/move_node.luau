local ChangeHistoryHelper = require(script.Parent.Parent.Shared.ChangeHistoryService)
local InstanceMap = require(script.Parent.Parent.Shared.InstanceMap)
local error = require(script.Parent.Parent.Utils.error)

return function(payload: { nodeId: string, newParentId: string? }): boolean
	local nodeId = payload.nodeId
	local newParentId = payload.newParentId

	local instance = InstanceMap[nodeId]

	if not instance then
		error("instance not found: " .. nodeId)
	end

	local newParent = nil
	if newParentId then
		newParent = InstanceMap[newParentId]

		if not newParent then
			error("new parent not found: " .. newParentId)
		end
	else
		newParent = game
	end

	local success, errorMessage = ChangeHistoryHelper.RecordOperation("MoveInstance", "Move Instance", function()
		instance.Parent = newParent
	end)

	if not success then
		error(errorMessage or "Failed to record move operation")
	end

	return true
end
