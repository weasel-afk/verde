local ChangeHistoryHelper = require(script.Parent.Parent.Shared.ChangeHistoryService)
local PropertyTracker = require(script.Parent.Parent.Shared.PropertyTracker)
local InstanceMap = require(script.Parent.Parent.Shared.InstanceMap)

return function(operation)
	local nodeId = operation.nodeId
	local oldName = operation.oldName
	local newName = operation.newName

	local instance = InstanceMap[nodeId]

	if not instance then
		return false, "Instance not found"
	end

	if not oldName or oldName == "" then
		return false, "Old attribute name is required"
	end

	if not newName or newName == "" then
		return false, "New attribute name is required"
	end

	-- get the current value
	local currentValue = instance:GetAttribute(oldName)

	if currentValue == nil then
		return false, "Attribute does not exist"
	end

	local success, errorMessage = ChangeHistoryHelper.RecordOperation("RenameAttribute", "Rename Attribute", function()
		instance:SetAttribute(newName, currentValue)
		instance:SetAttribute(oldName, nil)
	end)

	if not success then
		return false, errorMessage
	end

	PropertyTracker.triggerUpdate(nodeId)
	return true
end
