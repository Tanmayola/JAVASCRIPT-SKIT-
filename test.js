import {
    CloudFrontClient, ListDistributionsCommand, GetDistributionConfigCommand, UpdateDistributionCommand, DeleteDistributionCommand
  } from "@aws-sdk/client-cloudfront";
  import {
    S3Client, ListObjectsV2Command, DeleteObjectCommand, DeleteBucketCommand
  } from "@aws-sdk/client-s3";
  import {
    Route53Client, ListResourceRecordSetsCommand, ChangeResourceRecordSetsCommand, ListHostedZonesByNameCommand, DeleteHostedZoneCommand
  } from "@aws-sdk/client-route-53";
  import {
    ACMClient, ListCertificatesCommand, DeleteCertificateCommand
  } from "@aws-sdk/client-acm";
  import dotenv from "dotenv";
  
  dotenv.config();
  
  const cloudFrontClient = new CloudFrontClient({ region: process.env.AWS_ACM_REGION });
  const s3Client = new S3Client({ region: process.env.AWS_S3_REGION });
  const route53Client = new Route53Client({ region: process.env.AWS_ACM_REGION });
  const acmClient = new ACMClient({ region: process.env.AWS_ACM_REGION });
  
  const DOMAIN_NAME = process.env.DOMAIN_NAME;
  const bucketName = process.env.del_bucket;
  const distributionId = process.env.distributionId;
  
  async function disableCloudFrontDistribution(distributionId) {
      const getConfigCommand = new GetDistributionConfigCommand({ Id: distributionId });
      const configResponse = await cloudFrontClient.send(getConfigCommand);
  
      const config = configResponse.DistributionConfig;
      config.Enabled = false;
      const updateConfigCommand = new UpdateDistributionCommand({
          Id: distributionId,
          IfMatch: configResponse.ETag,
          DistributionConfig: config
      });
      await cloudFrontClient.send(updateConfigCommand);
  
      let disabled = false;
      while (!disabled) {
          const distribution = await cloudFrontClient.send(new ListDistributionsCommand({}));
          const dist = distribution.DistributionList.Items.find(dist => dist.Id === distributionId);
          if (dist.Status === "Deployed" && !dist.DistributionConfig.Enabled) {
              disabled = true;
          } else {
              await new Promise(resolve => setTimeout(resolve, 30000));
          }
      }
  }
  
  async function removeCertificateFromDistribution(distributionId) {
      const getConfigCommand = new GetDistributionConfigCommand({ Id: distributionId });
      const configResponse = await cloudFrontClient.send(getConfigCommand);
  
      const config = configResponse.DistributionConfig;
      if (config.ViewerCertificate && config.ViewerCertificate.ACMCertificateArn) {
          config.ViewerCertificate = {
              CloudFrontDefaultCertificate: true
          };
          const updateConfigCommand = new UpdateDistributionCommand({
              Id: distributionId,
              IfMatch: configResponse.ETag,
              DistributionConfig: config
          });
          await cloudFrontClient.send(updateConfigCommand);
      }
  }
  
  async function deleteCloudFrontDistribution(distributionId) {
      const deleteCommand = new DeleteDistributionCommand({
          Id: distributionId
      });
      await cloudFrontClient.send(deleteCommand);
  }
  
  async function deleteSSLCertificate(domainName) {
      const certs = await acmClient.send(new ListCertificatesCommand({}));
      const cert = certs.CertificateSummaryList.find(c => c.DomainName === domainName);
      if (cert) {
          await acmClient.send(new DeleteCertificateCommand({ CertificateArn: cert.CertificateArn }));
      } else {
          console.log(`Certificate for domain ${domainName} not found.`);
          return false;
      }
      return true;
  }
  
  async function emptyS3Bucket(bucketName) {
      console.log(`Emptying bucket: ${bucketName}`);
  
      let isTruncated = true;
      let continuationToken = null;
  
      while (isTruncated) {
          const listObjectsCommand = new ListObjectsV2Command({
              Bucket: bucketName,
              ContinuationToken: continuationToken
          });
          const response = await s3Client.send(listObjectsCommand);
  
          if (response.Contents) {
              for (const obj of response.Contents) {
                  console.log(`Deleting object: ${obj.Key}`);
                  await s3Client.send(new DeleteObjectCommand({ Bucket: bucketName, Key: obj.Key }));
              }
          }
  
          isTruncated = response.IsTruncated;
          continuationToken = response.NextContinuationToken;
      }
  }
  
  async function deleteS3Bucket(bucketName) {
      try {
          await emptyS3Bucket(bucketName);
          console.log(`Deleting bucket: ${bucketName}`);
          await s3Client.send(new DeleteBucketCommand({ Bucket: bucketName }));
      } catch (error) {
          console.log(`Bucket ${bucketName} not found.`);
          return false;
      }
      return true;
  }
  
  async function deleteDNSRecords(domainName) {
      const hostedZones = await route53Client.send(new ListHostedZonesByNameCommand({ DNSName: domainName }));
      if (hostedZones.HostedZones.length === 0) {
          console.log(`Hosted zone for domain ${domainName} not found.`);
          return false;
      }
  
      const hostedZoneId = hostedZones.HostedZones[0].Id;
      const recordSets = await route53Client.send(new ListResourceRecordSetsCommand({ HostedZoneId: hostedZoneId }));
  
      const changes = recordSets.ResourceRecordSets.filter(record =>
          record.Type === "A" || record.Type === "CNAME"
      ).filter(record =>
          record.Name === `${domainName}.` || record.Name === `www.${domainName}.`
      ).map(record => ({
          Action: "DELETE",
          ResourceRecordSet: record
      }));
  
      if (changes.length > 0) {
          await route53Client.send(new ChangeResourceRecordSetsCommand({
              HostedZoneId: hostedZoneId,
              ChangeBatch: { Changes: changes }
          }));
      }
  
      return true;
  }
  
  (async () => {
      try {
          console.log(`Domain name: ${DOMAIN_NAME}`);
          console.log(`Bucket name: ${bucketName}`);
  
          const distributions = await cloudFrontClient.send(new ListDistributionsCommand({}));
          const distribution = distributions.DistributionList.Items.find(dist => dist.Aliases.Items.includes(DOMAIN_NAME));
          if (distribution) {
              await disableCloudFrontDistribution(distribution.Id);
              await removeCertificateFromDistribution(distribution.Id);
              deleteCloudFrontDistribution(distribution.Id);  // Do not await this call
          } else {
              console.log(`CloudFront distribution for domain ${DOMAIN_NAME} not found.`);
              return;
          }
  
          const certDeleted = await deleteSSLCertificate(DOMAIN_NAME);
          if (!certDeleted) return;
  
          const bucketDeleted = await deleteS3Bucket(bucketName);
          if (!bucketDeleted) return;
  
          const dnsRecordsDeleted = await deleteDNSRecords(DOMAIN_NAME);
          if (!dnsRecordsDeleted) return;
  
      } catch (error) {
          console.error("Error:", error);
      }
  })();
  