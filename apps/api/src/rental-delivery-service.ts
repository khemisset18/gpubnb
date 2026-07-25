import crypto from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { appendOutboxEvent, enqueueMachineCommand } from './delivery-store.js';
import type { MachineCommandEnvelope, OutboxEnvelope } from './reliable-delivery.js';

type SqlClient = Pick<PrismaClient, '$executeRaw' | '$queryRaw'>;

export type RentalEventType = 'booking.created'|'booking.funded'|'rental.preparation_requested'|'rental.start_requested'|'rental.stop_requested'|'rental.completed'|'payment.settlement_requested'|'payment.settled'|'payment.refunded';
export type MachineRentalCommandType = 'prepare_rental'|'start_rental'|'stop_rental'|'cleanup_rental';

export interface RentalDeliveryContext { bookingId:string; machineId:string; renterId:string; listingId?:string; sessionId?:string; paymentId?:string; startsAt?:Date; endsAt?:Date }
export interface DeliveryWriteResult { eventId:string; commandId?:string; sequence?:bigint }

const SAFE_CUID=/^c[a-z0-9]{20,31}$/;
function assertCuid(value:string,field:string){if(!SAFE_CUID.test(value))throw new Error(`${field}_invalid`);return value}
function digest(...parts:string[]){return crypto.createHash('sha256').update(parts.join('|')).digest('hex')}
function stableId(prefix:string,...parts:string[]){return `${prefix}_${digest(...parts).slice(0,32)}`}
function stableKey(namespace:string,...parts:string[]){return `${namespace}:${digest(namespace,...parts).slice(0,48)}`}
function dateValue(value?:Date){if(value===undefined)return undefined;if(!(value instanceof Date)||Number.isNaN(value.getTime()))throw new Error('delivery_date_invalid');return value.toISOString()}
function cleanPayload(context:RentalDeliveryContext,extra:Record<string,unknown>={}){assertCuid(context.bookingId,'booking_id');assertCuid(context.machineId,'machine_id');assertCuid(context.renterId,'renter_id');if(context.listingId)assertCuid(context.listingId,'listing_id');if(context.sessionId)assertCuid(context.sessionId,'session_id');if(context.paymentId)assertCuid(context.paymentId,'payment_id');return {bookingId:context.bookingId,machineId:context.machineId,renterId:context.renterId,...(context.listingId?{listingId:context.listingId}:{}),...(context.sessionId?{sessionId:context.sessionId}:{}),...(context.paymentId?{paymentId:context.paymentId}:{}),...(context.startsAt?{startsAt:dateValue(context.startsAt)}:{}),...(context.endsAt?{endsAt:dateValue(context.endsAt)}:{}),...extra}}
async function reserveSequence(tx:SqlClient,machineId:string){assertCuid(machineId,'machine_id');const rows=await tx.$queryRaw<Array<{sequence:bigint}>>`SELECT reserve_machine_sequence(${machineId}) AS "sequence"`;const sequence=rows[0]?.sequence;if(sequence===undefined||sequence<1n)throw new Error('machine_sequence_reservation_failed');return sequence}

export async function recordRentalEvent(tx:SqlClient,eventType:RentalEventType,context:RentalDeliveryContext,extra:Record<string,unknown>={}):Promise<DeliveryWriteResult>{const payload=cleanPayload(context,extra);const eventId=stableId('evt',context.bookingId,eventType);const envelope:OutboxEnvelope={id:eventId,topic:eventType.startsWith('payment.')?'payments':'rentals',aggregateType:eventType.startsWith('payment.')?'payment':'booking',aggregateId:context.paymentId??context.bookingId,eventType,partitionKey:context.machineId,idempotencyKey:stableKey('event',context.bookingId,eventType),payload,headers:{schemaVersion:'1'}};await appendOutboxEvent(tx,envelope);return {eventId}}

export async function recordRentalEventAndCommand(tx:SqlClient,eventType:RentalEventType,commandType:MachineRentalCommandType,context:RentalDeliveryContext,expiresAt:Date,extra:Record<string,unknown>={}):Promise<DeliveryWriteResult>{const payload=cleanPayload(context,extra);const sequence=await reserveSequence(tx,context.machineId);const eventId=stableId('evt',context.bookingId,eventType);const commandId=stableId('cmd',context.machineId,context.bookingId,commandType);const event:OutboxEnvelope={id:eventId,topic:'rentals',aggregateType:'booking',aggregateId:context.bookingId,eventType,partitionKey:context.machineId,idempotencyKey:stableKey('event',context.bookingId,eventType),payload,headers:{schemaVersion:'1'}};const command:MachineCommandEnvelope={id:commandId,machineId:context.machineId,commandType,sequence,idempotencyKey:stableKey('command',context.machineId,context.bookingId,commandType),expiresAt,payload};await appendOutboxEvent(tx,event);await enqueueMachineCommand(tx,command);return {eventId,commandId,sequence}}

export const requestPreparation=(tx:SqlClient,context:RentalDeliveryContext)=>recordRentalEventAndCommand(tx,'rental.preparation_requested','prepare_rental',context,context.startsAt??new Date(Date.now()+15*60_000));
export const requestRentalStart=(tx:SqlClient,context:RentalDeliveryContext)=>recordRentalEventAndCommand(tx,'rental.start_requested','start_rental',context,context.endsAt??new Date(Date.now()+60*60_000));
export const requestRentalStop=(tx:SqlClient,context:RentalDeliveryContext,reason:'renter'|'owner'|'platform')=>recordRentalEventAndCommand(tx,'rental.stop_requested','stop_rental',context,new Date(Date.now()+5*60_000),{reason});
export const requestCleanup=(tx:SqlClient,context:RentalDeliveryContext)=>recordRentalEventAndCommand(tx,'rental.completed','cleanup_rental',context,new Date(Date.now()+15*60_000));
