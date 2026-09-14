local ChangeHistoryHelper = require(script.Parent.Parent.Shared.ChangeHistoryService)
local InstanceMap = require(script.Parent.Parent.Shared.InstanceMap)
local NameUtils = require(script.Parent.Parent.Utils.name)
local error = require(script.Parent.Parent.Utils.error)

return function(payload: { nodeId: string }): boolean
	local nodeId = payload.nodeId

	local instance = InstanceMap[nodeId]

	if not instance then
		error("instance not found: " .. nodeId)
	end

	local clonedInstance = instance:Clone()

	local baseName, _ = NameUtils.ParseName(instance.Name)
	local newName = NameUtils.GetValidName(instance.Parent, baseName)

	clonedInstance.Name = newName

	local success, errorMessage = ChangeHistoryHelper.RecordOperation(
		"DuplicateInstance",
		"Duplicate Instance",
		function()
			clonedInstance.Parent = instance.Parent
		end
	)

	if not success then
		clonedInstance:Destroy()
		error(errorMessage or "Failed to record duplicate operation")
	end

	local newId = clonedInstance:GetDebugId(0)
	InstanceMap[newId] = clonedInstance

	return true
end
