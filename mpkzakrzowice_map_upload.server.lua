-- MPKZAKRZOWICE — jednorazowy import mapy do trwałej bazy Neon.
-- Umieść jako zwykły Script w ServerScriptService w opublikowanej grze.
-- Po udanym imporcie usuń ten skrypt z projektu i opublikuj zmiany.

local HttpService = game:GetService("HttpService")

local API_URL = "https://mpkzakrzowice-live.onrender.com/api/map/import-chunk"
local API_SECRET_NAME = "MPK_API_KEY"
local ORIGIN_X, ORIGIN_Z = -17032.465637922352, -16253.21875
local STEP = 5.05
local CHUNK_SIZE = 1800 -- podzielne przez 9, tak aby rekord nie przecinał fragmentu
local ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
local TARGET = Color3.fromRGB(17, 17, 17)

local secretOk, apiSecret = pcall(function()
    return HttpService:GetSecret(API_SECRET_NAME)
end)
if not secretOk then
    warn("[mpkzakrzowice-import] Brak sekretu MPK_API_KEY w Creator Dashboard > Secrets.")
    return
end

local function encode64(n, width)
    local out = {}
    for i = width, 1, -1 do
        local digit = math.floor(n / (64 ^ (i - 1))) % 64
        out[#out + 1] = ALPHABET:sub(digit + 1, digit + 1)
    end
    return table.concat(out)
end

print("[mpkzakrzowice-import] Skanuję części dróg...")
task.wait(2)
local records = {}
local roadCount = 0

for _, v in ipairs(workspace:GetDescendants()) do
    if v:IsA("BasePart") and v.Material == Enum.Material.Asphalt then
        local c = v.Color
        if math.abs(c.R - TARGET.R) < 0.01
            and math.abs(c.G - TARGET.G) < 0.01
            and math.abs(c.B - TARGET.B) < 0.01 then

            local p = v.Position
            local x = math.floor((p.X - ORIGIN_X) / STEP + 0.5)
            local z = math.floor((p.Z - ORIGIN_Z) / STEP + 0.5)
            if x >= 0 and x <= 4095 and z >= 0 and z <= 4095 then
                local sx = math.clamp(math.floor(v.Size.X * 2 + 0.5), 1, 4095)
                local sz = math.clamp(math.floor(v.Size.Z * 2 + 0.5), 1, 4095)
                local right = v.CFrame.RightVector
                local angle = math.atan2(right.Z, right.X)
                local angleIndex = math.floor(((angle / (2 * math.pi)) % 1) * 64 + 0.5) % 64
                records[#records + 1] = encode64(x, 2) .. encode64(z, 2)
                    .. encode64(sx, 2) .. encode64(sz, 2)
                    .. ALPHABET:sub(angleIndex + 1, angleIndex + 1)
                roadCount += 1
            end
        end
    end
end

local data = table.concat(records)
if #data == 0 or #data % 9 ~= 0 then
    warn("[mpkzakrzowice-import] Eksport pusty lub nieprawidłowy; przerwano.")
    return
end

local total = math.ceil(#data / CHUNK_SIZE)
local uploadId = HttpService:GenerateGUID(false)
print(string.format("[mpkzakrzowice-import] Znaleziono %d części dróg; wysyłam %d fragmentów.", roadCount, total))

for index = 1, total do
    local from = (index - 1) * CHUNK_SIZE + 1
    local chunk = data:sub(from, from + CHUNK_SIZE - 1)
    local ok, response = pcall(function()
        return HttpService:RequestAsync({
            Url = API_URL,
            Method = "POST",
            Headers = {
                ["Content-Type"] = "application/json",
                ["x-api-key"] = apiSecret,
            },
            Body = HttpService:JSONEncode({ uploadId = uploadId, index = index, total = total, chunk = chunk }),
        })
    end)

    if not ok then
        warn("[mpkzakrzowice-import] Błąd wysyłania fragmentu " .. index .. ": " .. tostring(response))
        return
    end
    if not response.Success then
        warn("[mpkzakrzowice-import] API zwróciło HTTP " .. tostring(response.StatusCode) .. ": " .. tostring(response.Body))
        return
    end

    local decodedOk, result = pcall(function() return HttpService:JSONDecode(response.Body) end)
    if not decodedOk or not result.ok then
        warn("[mpkzakrzowice-import] Nieprawidłowa odpowiedź API przy fragmencie " .. index .. ".")
        return
    end
    if result.skipped then
        print("[mpkzakrzowice-import] Mapa już jest zapisana w Neon — import pominięty.")
        return
    end
    if index % 4 == 0 or index == total then
        print(string.format("[mpkzakrzowice-import] Wysłano fragment %d/%d.", index, total))
    end
    task.wait(0.12)
end

print("[mpkzakrzowice-import] SUKCES — mapa została zapisana w Neon i powinna przetrwać restarty Render.")
print("[mpkzakrzowice-import] Usuń ten tymczasowy Script z ServerScriptService i opublikuj zmiany, aby nie wykonywał importu przy kolejnych uruchomieniach.")
