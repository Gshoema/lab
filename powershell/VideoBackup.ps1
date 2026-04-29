<#
--------PATHS/Resources------------
D:\caspar

\\van\AK1-Share\Resolutions\FL26\K
D:\Archive\FL26\K
\\192.168.200.94\ava\2025\FL26\K

192.168.16.52/functions/lotday.cfm



---------Scope---------------------

The purpose of this script is to automate the video backup process on the caspar server. This should handle all of that multistep process.



-------What it does----------------
Gather the Year, Auction ID and Lot Day dynamically from  SF and store them in their own variables.
Use the variable to build the destinatio PATHs that the files will dump into.

RoboCopy the files from C:\caspar to their final destinations for backup and resolutions/legal.

Remove the files from C:\caspar for use the next day. <<<<<<Commented for first few executions.



-----------Future Tasks--------------------
Sanity Checks
Output the values of $Year, $AuctionID, $LotDay. Have a user verify their correctness before proceeding.

Scheduled Task
Automate it to run at night. If above is unnecessary.(Will still need to manually run it last day of auction)

------------SCRIPT START-------------------#>
$Date = Get-Date -Format "yyyyMMdd_HHmmss"

$Year = Get-Date -Format "yyyy"



#Get Auction Code information from 192.168.16.52/functions/lotday.cfm and chop it down with regex

$AuctionID = Invoke-WebRequest -Uri 192.168.16.52/functions/lotday.cfm -UseBasicParsing | findstr auctionid

$AuctionID = $AuctionID -replace "Content           : {auctionid:", ""
$AuctionID = $AuctionID -replace ",lotDay.+", ""


$LotDay = Invoke-WebRequest -Uri 192.168.16.52/functions/lotday.cfm -UseBasicParsing | findstr auctionid

$LotDay = $LotDay -replace "Content           : {auctionid:....,LotDay:", ""
$LotDay = $LotDay -replace "}.+", ""



#Copy the contents of each folder to the destination
#/XF "Desktop.ini" added because folder names were getting wonky.
robocopy "D:\caspar\" "\\van\AK1-Share\Resolutions\$AuctionID\$LotDay\" /ZB /XF "Desktop.ini" /MT /R:2 /W:5 /TEE /LOG:C:\logs\robocopy_auction-$($Date).log /DCOPY:DAT /COPY:DAT

robocopy "D:\caspar\" "\192.168.200.94\ava\$Year\$AuctionID\$LotDay\" /ZB /XF "Desktop.ini" /MT /R:2 /W:5 /TEE /LOG:C:\logs\robocopy_auction-$($Date).log /DCOPY:DAT /COPY:DAT

robocopy "D:\caspar\" "D:\Archive\$AuctionID\$LotDay\" /ZB /XF "Desktop.ini" /MT /R:2 /W:5 /TEE /LOG:C:\logs\robocopy_auction-$($Date).log /DCOPY:DAT /COPY:DAT

#Remove-Item -Path "C:\caspar\*"