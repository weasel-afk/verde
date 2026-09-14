local Services = require(script.Parent.Parent.Shared.Services)

return function(instance: Instance): boolean
	for _, serviceName in Services do
		local service = game:GetService(serviceName)
		if instance:IsDescendantOf(service) then
			return true
		end
	end

	return false
end
