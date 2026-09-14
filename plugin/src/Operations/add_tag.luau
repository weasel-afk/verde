local ChangeHistoryHelper = require(script.Parent.Parent.Shared.ChangeHistoryService)
local PropertyTracker = require(script.Parent.Parent.Shared.PropertyTracker)
local InstanceMap = require(script.Parent.Parent.Shared.InstanceMap)

return function(operation)
	local nodeId = operation.nodeId
	local tagName = operation.tagName

	local instance = InstanceMap[nodeId]

	if not instance then
		return false, "Instance not found"
	end

	if not tagName or tagName == "" then
		return false, "Tag name is required"
	end

	local success, errorMessage = ChangeHistoryHelper.RecordOperation("AddTag", "Add Tag", function()
		instance:AddTag(tagName)
	end)

	if not success then
		return false, errorMessage
	end

	PropertyTracker.triggerUpdate(nodeId)

	return true
end
