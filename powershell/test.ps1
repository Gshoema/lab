$AuctionID = Invoke-WebRequest -Uri 192.168.16.52/functions/lotday.cfm -UseBasicParsing | findstr auctionid

$AuctionID = $AuctionID -replace "Content           : {auctionid:", ""
$AuctionID = $AuctionID -replace ",lotDay.+", ""

Write-Output $AuctionID


$LotDay = Invoke-WebRequest -Uri 192.168.16.52/functions/lotday.cfm -UseBasicParsing | findstr auctionid

$LotDay = $LotDay -replace "Content           : {auctionid:....,LotDay:", ""
$LotDay = $LotDay -replace "}.+", ""

Write-Output $LotDay

$Year = Get-Date -Format "yyyy"

Write-Output $Year