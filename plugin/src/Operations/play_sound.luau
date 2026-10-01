local InstanceMap = require(script.Parent.Parent.Shared.InstanceMap)
local SoundPlayer = require(script.Parent.Parent.Shared.SoundPlayer)

return function(operation)
	local nodeId = operation.nodeId

	local instance = InstanceMap[nodeId]

	if not instance then
		return false, "instance not found"
	end

	if not instance:IsA("Sound") then
		return false, "instance is not a Sound"
	end

	return SoundPlayer.play(instance, nodeId)
end
