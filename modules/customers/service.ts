import mongoose from 'mongoose';
import { CustomerProfile, ICustomerProfile, ISavedAddress } from '../../models/CustomerProfile';
import { User } from '../../models/User';
import logger from '../../config/logger';

export class CustomerService {
  /**
   * Retrieves or initializes customer profile for a given user.
   */
  static async getProfile(userId: string): Promise<any> {
    const user = await User.findById(userId).select('-password -__v');
    if (!user) {
      const err = new Error('User not found') as any;
      err.statusCode = 404;
      err.code = 'USER_NOT_FOUND';
      throw err;
    }

    let profile = await CustomerProfile.findOne({ userId });
    if (!profile) {
      profile = await CustomerProfile.create({
        userId,
        savedAddresses: [],
        notificationPreferences: { email: true, push: false, sms: true },
      });
    }

    return {
      userId: user._id.toString(),
      email: user.email,
      fullName: user.fullName,
      phone: user.phone,
      role: user.role,
      status: user.status,
      emailVerified: user.emailVerified,
      savedAddresses: profile.savedAddresses,
      notificationPreferences: profile.notificationPreferences,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
    };
  }

  /**
   * Updates notification preferences on the customer profile.
   */
  static async updateProfile(userId: string, data: { notificationPreferences?: any }): Promise<any> {
    let profile = await CustomerProfile.findOne({ userId });
    if (!profile) {
      profile = new CustomerProfile({ userId, savedAddresses: [] });
    }

    if (data.notificationPreferences) {
      profile.notificationPreferences = {
        ...profile.notificationPreferences,
        ...data.notificationPreferences,
      };
    }

    await profile.save();
    return this.getProfile(userId);
  }

  /**
   * Adds a new address to savedAddresses.
   */
  static async addAddress(userId: string, addressData: Partial<ISavedAddress>): Promise<ISavedAddress[]> {
    let profile = await CustomerProfile.findOne({ userId });
    if (!profile) {
      profile = await CustomerProfile.create({
        userId,
        savedAddresses: [],
        notificationPreferences: { email: true, push: false, sms: true },
      });
    }

    if (addressData.isDefault) {
      // Unset other defaults
      profile.savedAddresses.forEach((addr: ISavedAddress) => {
        addr.isDefault = false;
      });
    } else if (profile.savedAddresses.length === 0) {
      // First address defaults to true
      addressData.isDefault = true;
    }

    profile.savedAddresses.push(addressData as ISavedAddress);
    await profile.save();
    logger.info({ userId }, 'Customer saved address added');
    return profile.savedAddresses;
  }

  /**
   * Updates an existing saved address.
   */
  static async updateAddress(
    userId: string,
    addressId: string,
    addressData: Partial<ISavedAddress>
  ): Promise<ISavedAddress[]> {
    const profile = await CustomerProfile.findOne({ userId });
    if (!profile) {
      const err = new Error('Customer profile not found') as any;
      err.statusCode = 404;
      err.code = 'NOT_FOUND';
      throw err;
    }

    const address = (profile.savedAddresses as any).id(addressId);
    if (!address) {
      const err = new Error('Address not found') as any;
      err.statusCode = 404;
      err.code = 'NOT_FOUND';
      throw err;
    }

    if (addressData.isDefault) {
      profile.savedAddresses.forEach((addr: ISavedAddress) => {
        addr.isDefault = false;
      });
    }

    Object.assign(address, addressData);
    await profile.save();
    logger.info({ userId, addressId }, 'Customer saved address updated');
    return profile.savedAddresses;
  }

  /**
   * Deletes a saved address.
   */
  static async deleteAddress(userId: string, addressId: string): Promise<ISavedAddress[]> {
    const profile = await CustomerProfile.findOne({ userId });
    if (!profile) {
      const err = new Error('Customer profile not found') as any;
      err.statusCode = 404;
      err.code = 'NOT_FOUND';
      throw err;
    }

    const address = (profile.savedAddresses as any).id(addressId);
    if (!address) {
      const err = new Error('Address not found') as any;
      err.statusCode = 404;
      err.code = 'NOT_FOUND';
      throw err;
    }

    (address as any).deleteOne();
    await profile.save();
    logger.info({ userId, addressId }, 'Customer saved address deleted');
    return profile.savedAddresses;
  }
}
